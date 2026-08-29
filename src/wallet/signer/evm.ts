import { TW } from '@trustwallet/wallet-core';
import { config } from '../../config';
import type { CurrencyDef } from '../../currencies';
import { rpc, endpointList, tryEndpoints } from '../../util/http';
import { parseHexOrDec } from '../../util/decimal';
import { logger } from '../../util/log';
import { getCore, coinTypeByName } from '../core';
import { privateKeyBytes } from '../keys';
import { toBytes, hexOf, type ChainSigner, type SendRequest, type SendResult } from './types';

const log = logger('sign:evm');

/** Chain id and wallet-core coin per EVM chain. */
const EVM: Record<string, { chainId: bigint; coin: string; rpcUrl: () => string }> = {
  ethereum: { chainId: 1n, coin: 'ethereum', rpcUrl: () => config.rpc.ethereum },
  bsc: { chainId: 56n, coin: 'smartChain', rpcUrl: () => config.rpc.bsc },
};

/** keccak256("transfer(address,uint256)") — the ERC-20 selector. */
const TRANSFER_SELECTOR = '0xa9059cbb';

export function evmSigner(chainId: string): ChainSigner {
  const meta = EVM[chainId];
  if (!meta) throw new Error(`${chainId} is not an EVM chain`);

  // Endpoints are tried in order. Re-sending an already-signed transaction to a
  // second node is harmless — it has the same hash and the network deduplicates.
  const call = <T>(method: string, params: unknown[] = []): Promise<T> =>
    tryEndpoints(endpointList(meta.rpcUrl()), (base) => rpc<T>(base, method, params));

  return {
    async balance(currency: CurrencyDef, address: string): Promise<bigint> {
      if (currency.kind === 'native') {
        return parseHexOrDec(await call<string>('eth_getBalance', [address, 'latest']));
      }
      // balanceOf(address) — selector 0x70a08231, argument left-padded to 32 bytes.
      const data = '0x70a08231' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      const result = await call<string>('eth_call',
        [{ to: currency.contract, data }, 'latest']);
      return parseHexOrDec(result && result !== '0x' ? result : '0x0');
    },

    async send(req: SendRequest): Promise<SendResult> {
      const core = await getCore();
      const coin = coinTypeByName(core, meta.coin);
      const key = await privateKeyBytes(chainId, req.fromIndex);

      const [nonceRaw, gasPriceRaw] = await Promise.all([
        call<string>('eth_getTransactionCount', [req.fromAddress, 'pending']),
        call<string>('eth_gasPrice'),
      ]);
      const nonce = parseHexOrDec(nonceRaw);
      // A little headroom so the transaction is not stuck if the price ticks up.
      const gasPrice = (parseHexOrDec(gasPriceRaw) * 12n) / 10n;

      const isNative = req.currency.kind === 'native';
      const gasLimit = isNative ? 21000n : await estimateTokenGas(call, req);

      let amount: bigint;
      let fee = gasPrice * gasLimit;

      if (isNative) {
        const balance = parseHexOrDec(await call<string>('eth_getBalance', [req.fromAddress, 'latest']));
        if (req.sweep) {
          // Everything except what the transaction itself costs.
          if (balance <= fee) {
            throw new Error(`balance ${balance} is below the ${fee} fee — nothing to sweep`);
          }
          amount = balance - fee;
        } else {
          amount = req.amount;
          if (balance < amount + fee) {
            throw new Error(`insufficient balance: need ${amount + fee} (amount plus fee), have ${balance}`);
          }
        }
      } else {
        // A token transfer is paid for in the chain's native coin, which the
        // address must already hold — this is the classic stuck-deposit case.
        const nativeBalance = parseHexOrDec(await call<string>('eth_getBalance', [req.fromAddress, 'latest']));
        if (nativeBalance < fee) {
          const nativeName = chainId === 'bsc' ? 'BNB' : 'ETH';
          throw new Error(`this address holds no ${nativeName} to pay gas. Send about `
            + `${fee} wei of ${nativeName} to ${req.fromAddress} first, then retry.`);
        }
        const tokenBalance = await this.balance(req.currency, req.fromAddress);
        amount = req.sweep ? tokenBalance : req.amount;
        if (tokenBalance < amount) {
          throw new Error(`insufficient token balance: need ${amount}, have ${tokenBalance}`);
        }
        if (amount === 0n) throw new Error('nothing to send');
      }

      const transaction = isNative
        ? TW.Ethereum.Proto.Transaction.create({
            transfer: TW.Ethereum.Proto.Transaction.Transfer.create({ amount: toBytes(amount) }),
          })
        : TW.Ethereum.Proto.Transaction.create({
            erc20Transfer: TW.Ethereum.Proto.Transaction.ERC20Transfer.create({
              to: req.toAddress,
              amount: toBytes(amount),
            }),
          });

      const input = TW.Ethereum.Proto.SigningInput.create({
        chainId: toBytes(meta.chainId),
        nonce: toBytes(nonce),
        gasPrice: toBytes(gasPrice),
        gasLimit: toBytes(gasLimit),
        // For a token the transaction is addressed to the contract; the
        // recipient travels inside the call data.
        toAddress: isNative ? req.toAddress : req.currency.contract!,
        privateKey: key,
        transaction,
      });

      const encoded = TW.Ethereum.Proto.SigningInput.encode(input).finish();
      const signed = TW.Ethereum.Proto.SigningOutput.decode(core.AnySigner.sign(encoded, coin));
      if (signed.error) throw new Error(`signing failed: ${signed.errorMessage || signed.error}`);

      const rawTx = '0x' + hexOf(signed.encoded);
      const txid = await call<string>('eth_sendRawTransaction', [rawTx]);
      log.info(`${chainId}: broadcast ${txid}`);

      return { txid, sent: amount, fee };
    },
  };
}

type RpcCall = <T>(method: string, params?: unknown[]) => Promise<T>;

async function estimateTokenGas(call: RpcCall, req: SendRequest): Promise<bigint> {
  const data = TRANSFER_SELECTOR
    + req.toAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0')
    + req.amount.toString(16).padStart(64, '0');
  try {
    const estimate = parseHexOrDec(await call<string>('eth_estimateGas', [{
      from: req.fromAddress, to: req.currency.contract, data,
    }]));
    // Estimates run tight; a margin avoids an out-of-gas revert.
    return (estimate * 13n) / 10n;
  } catch {
    // Typical ERC-20 transfers land well inside this.
    return 100_000n;
  }
}

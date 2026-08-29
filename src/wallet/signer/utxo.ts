import { TW } from '@trustwallet/wallet-core';
import { config } from '../../config';
import { getChain } from '../../chains';
import type { CurrencyDef } from '../../currencies';
import { fetchJson } from '../../util/http';
import { logger } from '../../util/log';
import { getCore, coinTypeByName } from '../core';
import { privateKeyBytes } from '../keys';
import { hexOf, type ChainSigner, type SendRequest, type SendResult } from './types';

const log = logger('sign:utxo');

/** Blockbook base URL per chain. */
function blockbookUrl(chainId: string): string {
  const urls: Record<string, string> = {
    bitcoin: config.rpc.bitcoin,
    litecoin: config.rpc.litecoin,
    dogecoin: config.rpc.dogecoin,
    dash: config.rpc.dash,
    bitcoincash: config.rpc.bitcoincash,
    zcash: config.rpc.zcash,
  };
  const url = urls[chainId];
  if (!url) throw new Error(`${chainId} is not a UTXO chain`);
  return url.replace(/\/$/, '');
}

/** Satoshis per byte. Deliberately generous — a stuck sweep is worse. */
const BYTE_FEE: Record<string, number> = {
  bitcoin: 15,
  litecoin: 10,
  dogecoin: 1000,   // DOGE fees are quoted in much larger units
  dash: 10,
  bitcoincash: 5,
  zcash: 10,
};

interface BbUtxo { txid: string; vout: number; value: string; confirmations?: number }

export function utxoSigner(chainId: string): ChainSigner {
  return {
    async balance(_currency: CurrencyDef, address: string): Promise<bigint> {
      const utxos = await fetchUtxos(chainId, address);
      return utxos.reduce((total, u) => total + BigInt(u.value), 0n);
    },

    async send(req: SendRequest): Promise<SendResult> {
      const chain = getChain(chainId);
      const core = await getCore();
      const coin = coinTypeByName(core, chain.walletCoreCoin!);
      const key = await privateKeyBytes(chainId, req.fromIndex);

      const utxos = await fetchUtxos(chainId, req.fromAddress);
      if (utxos.length === 0) throw new Error('this address holds no unspent outputs');
      const total = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);

      // The locking script is derived from our own address rather than fetched,
      // since Blockbook does not return it with the UTXO list.
      const script = core.BitcoinScript.lockScriptForAddress(req.fromAddress, coin).data();

      const inputs = utxos.map((u) => TW.Bitcoin.Proto.UnspentTransaction.create({
        outPoint: TW.Bitcoin.Proto.OutPoint.create({
          // Transaction ids are displayed reversed relative to their bytes.
          hash: reverseHex(u.txid),
          index: u.vout,
          sequence: 0xffffffff,
        }),
        amount: Number(BigInt(u.value)),
        script,
      }));

      const amount = req.sweep ? total : req.amount;
      if (!req.sweep && total < amount) {
        throw new Error(`insufficient balance: need ${amount}, have ${total}`);
      }

      const input = TW.Bitcoin.Proto.SigningInput.create({
        hashType: core.BitcoinSigHashType.all.value,
        amount: Number(amount),
        byteFee: BYTE_FEE[chainId] ?? 10,
        toAddress: req.toAddress,
        changeAddress: req.fromAddress,
        privateKey: [key],
        utxo: inputs,
        coinType: coin.value,
        // A sweep sends the balance less fees rather than a fixed amount.
        useMaxAmount: req.sweep,
      });

      const encoded = TW.Bitcoin.Proto.SigningInput.encode(input).finish();
      const signed = TW.Bitcoin.Proto.SigningOutput.decode(core.AnySigner.sign(encoded, coin));
      if (signed.error) throw new Error(`signing failed: ${signed.errorMessage || signed.error}`);

      const rawTx = hexOf(signed.encoded);
      const txid = await broadcast(chainId, rawTx);
      const fee = total - BigInt(signed.transaction?.outputs?.reduce(
        (sum: number, o: any) => sum + Number(o.value ?? 0), 0) ?? 0);
      log.info(`${chainId}: broadcast ${txid}`);

      return { txid, sent: req.sweep ? total - fee : amount, fee: fee > 0n ? fee : 0n };
    },
  };
}

async function fetchUtxos(chainId: string, address: string): Promise<BbUtxo[]> {
  const url = `${blockbookUrl(chainId)}/api/v2/utxo/${encodeURIComponent(address)}`;
  const utxos = await fetchJson<BbUtxo[]>(url, { timeoutMs: 25000 });
  return (utxos ?? []).filter((u) => BigInt(u.value) > 0n);
}

async function broadcast(chainId: string, rawTxHex: string): Promise<string> {
  const url = `${blockbookUrl(chainId)}/api/v2/sendtx/`;
  const result = await fetchJson<{ result?: string; error?: { message?: string } }>(url, {
    method: 'POST',
    body: rawTxHex,
    headers: { 'content-type': 'text/plain' },
    timeoutMs: 30000,
    retries: 0, // never risk broadcasting the same transaction twice
  });
  if (result?.error) throw new Error(`broadcast rejected: ${result.error.message ?? 'unknown'}`);
  if (!result?.result) throw new Error('broadcast returned no transaction id');
  return result.result;
}

/** "aabbcc" -> bytes in reverse order, as an outpoint hash wants. */
function reverseHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[bytes.length - 1 - i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

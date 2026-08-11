import { EventEmitter } from 'node:events';
import type { DepositRow } from './db/repo';

/**
 * Domain events.
 *
 * The watcher emits; notifiers (Telegram, and anything you add later)
 * subscribe. Keeping this in the middle means the deposit pipeline never has to
 * know who is listening, and a broken notifier can never break crediting.
 */
export interface GatewayEvents {
  'deposit.pending': (deposit: DepositRow) => void;
  'deposit.completed': (deposit: DepositRow) => void;
}

class TypedEmitter extends EventEmitter {
  emitEvent<K extends keyof GatewayEvents>(event: K, ...args: Parameters<GatewayEvents[K]>): void {
    // Never let a listener's failure propagate back into the caller.
    try {
      this.emit(event, ...args);
    } catch {
      /* listeners handle their own errors */
    }
  }

  onEvent<K extends keyof GatewayEvents>(event: K, listener: GatewayEvents[K]): void {
    this.on(event, listener as (...args: unknown[]) => void);
  }
}

export const events = new TypedEmitter();

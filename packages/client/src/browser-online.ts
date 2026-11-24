import { NetworkClient, readSeat } from './network-client.js';
import { mountOnline } from './online.js';

const seatKey = 'office-worms.match.v2';

export function mountBrowserOnline(root: HTMLElement): () => void {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const defaultAddress = scheme + '://' + (location.hostname || '127.0.0.1') + ':4180/ws';
  const client = new NetworkClient(defaultAddress, seat => {
    try {
      if (seat) sessionStorage.setItem(seatKey, JSON.stringify(seat));
      else sessionStorage.removeItem(seatKey);
    } catch { /* The connection can still recover in memory. */ }
  });
  try {
    const seat = readSeat(sessionStorage.getItem(seatKey));
    if (seat) {
      client.setDefaultAddress(seat.url);
      client.restore(seat);
    }
  } catch { /* Storage can be unavailable. */ }
  const stop = mountOnline(root, client);
  return () => { stop(); client.dispose(); };
}

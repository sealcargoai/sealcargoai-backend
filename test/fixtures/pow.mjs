// Solves a proof-of-work challenge like the browser does (test helper).
import { powBits } from "../../src/services/verifyStore.js";
export function solve(challenge, bits) {
  for (let n = 0; ; n++) if (powBits(challenge, String(n)) >= bits) return String(n);
}
/** start() that answers the challenge when asked (like the browser), returning the final result. */
export function startSolving(store, email, ip, now, opts = {}) {
  let r = store.start(email, ip, now, opts);
  // the difficulty can rise while solving (others used the budget meanwhile): ask again, like the browser
  for (let k = 0; k < 3 && !r.ok && r.reason === "challenge"; k++) {
    const challenge = store.challenge(email, ip, r.bits, now);
    r = store.start(email, ip, now, { ...opts, pow: { challenge, nonce: solve(challenge, r.bits) } });
  }
  return r;
}

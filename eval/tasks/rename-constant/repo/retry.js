import { MAX_RETRY } from "./config.js";
export function attempts() {
  let n = 0;
  while (n < MAX_RETRY) n++;
  return n;
}

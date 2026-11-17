import { attempts } from "./retry.js";
import { MAX_RETRY } from "./config.js";
console.log(attempts() === MAX_RETRY ? "ok " + MAX_RETRY : "mismatch");

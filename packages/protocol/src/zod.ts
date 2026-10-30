import { z } from 'zod';

/**
 * Every protocol module imports `z` from here, so this runs before any schema is constructed.
 *
 * `jitless` keeps zod from compiling object parsers with `new Function`: that is refused by the CSP every
 * published game carries (`script-src` without `'unsafe-eval'`) and by Hermes in the shell, and zod probes for
 * it at *schema construction* time (`util.allowsEval`), which is why configuring it later (in the SDK, after
 * the protocol schemas exist) still produced a `securitypolicyviolation` report in the game's WebView. The parse
 * volume everywhere (a few bridge envelopes per second at most) does not need the compiled fast path.
 */
z.config({ jitless: true });

export { z };

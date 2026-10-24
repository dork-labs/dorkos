/**
 * Keep the page's schema checks from trying `eval`. Zod probes once whether it may compile its
 * checks with `new Function`, and the page's content security policy refuses that (DOR-2957).
 * The refusal is caught, but the browser still reports it, and a page that asks for something
 * its policy refuses hides real refusals in the noise. `main.tsx` imports this before any schema
 * runs.
 */
import { config } from 'zod';

config({ jitless: true });

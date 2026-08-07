/**
 * Stands in for the `server-only` package under vitest.
 *
 * Next.js resolves `server-only` through a built-in alias, so it is never a
 * real dependency in `package.json` and vitest cannot find it. Importing it is
 * a compile-time assertion — "this module must not reach a client bundle" —
 * with no runtime behaviour, so an empty module is a faithful substitute.
 *
 * Aliased in `vitest.config.ts`. The alternative was deleting the
 * `import "server-only"` line from modules that read the filesystem, which
 * would trade a test-config line for the loss of a real guard.
 */
export {};

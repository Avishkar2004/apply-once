/**
 * Vite's `?raw` suffix inlines a file's contents as a string at build time.
 *
 * The test harness uses this for `schema.sql`: `workerd` has no filesystem, so
 * reading the schema at runtime is not an option — it has to be baked in.
 */
declare module '*.sql?raw' {
  const contents: string;
  export default contents;
}

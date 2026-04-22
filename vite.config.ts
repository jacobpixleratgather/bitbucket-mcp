import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: "./src/bin/bitbucket-mcp.ts",
    dts: false,
    // Do NOT auto-write back to package.json. tsdown derives the `bin` key
    // from the package's unscoped name (`server` from `@bb-mcp/server`),
    // which would clobber the deliberate `bin: bitbucket-mcp` entry on every
    // build. `exports` and `bin` are stable enough to maintain by hand.
    exports: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});

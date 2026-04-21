import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: "./src/bin/bitbucket-mcp.ts",
    dts: false,
    exports: {
      packageJson: true,
      bin: "./src/bin/bitbucket-mcp.ts",
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});

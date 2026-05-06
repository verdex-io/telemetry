import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  input: "./openapi.json",
  output: "./src/client",
  plugins: [
    "@hey-api/client-fetch",
    {
      name: "@hey-api/sdk",
      asClass: false,
      operationId: true,
    },
    {
      name: "@hey-api/schemas",
      type: "json",
    },
  ],
})

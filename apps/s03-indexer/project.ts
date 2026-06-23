import {
  StellarDatasourceKind,
  StellarHandlerKind,
  StellarProject,
} from "@subql/types-stellar"

import * as dotenv from "dotenv"
import fs from "fs"
import path from "path"

const mode = process.env.NODE_ENV || "production"

// Load the appropriate .env file
const dotenvPath = path.resolve(
  __dirname,
  `.env${mode !== "production" ? `.${mode}` : ""}`
)
dotenv.config({ path: dotenvPath, quiet: true })

const configNetwork =
  process.env.INDEXER_NETWORK ??
  (mode === "production" || mode === "develop" ? "testnet" : mode)

type IndexerContractConfig = {
  network: {
    name: string
    passphrase: string
    horizonUrl: string
    sorobanRpcUrl: string
  }
  contracts: Record<string, string>
  tokens: Record<string, string>
  markets: Array<{
    name: string
    marketToken: string
    indexToken: string
    longToken: string
    shortToken: string
  }>
}

function loadIndexerContractConfig(): IndexerContractConfig {
  const configPath =
    process.env.INDEXER_CONTRACT_CONFIG ??
    path.resolve(__dirname, "config", `contracts.${configNetwork}.json`)

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing indexer contract config at ${configPath}. Run bun run --cwd apps/s03-indexer sync:contracts:${configNetwork}.`
    )
  }

  return JSON.parse(
    fs.readFileSync(configPath, "utf8")
  ) as IndexerContractConfig
}

const contractConfig = loadIndexerContractConfig()

const indexedContractIds = Array.from(
  new Set([
    ...Object.values(contractConfig.contracts),
    ...Object.values(contractConfig.tokens),
    ...contractConfig.markets.flatMap((market) => [
      market.marketToken,
      market.indexToken,
      market.longToken,
      market.shortToken,
    ]),
  ])
)

const endpoint = process.env.ENDPOINT ?? contractConfig.network.horizonUrl
const chainId = process.env.CHAIN_ID ?? contractConfig.network.passphrase
const sorobanEndpoint =
  process.env.SOROBAN_ENDPOINT ?? contractConfig.network.sorobanRpcUrl

/* This is your project configuration */
const project: StellarProject = {
  specVersion: "1.0.0",
  name: `so4-market-${contractConfig.network.name}`,
  version: "0.0.1",
  runner: {
    node: {
      name: "@subql/node-stellar",
      version: "*",
    },
    query: {
      name: "@subql/query",
      version: "*",
    },
  },
  description: `SO4 market indexer for ${contractConfig.network.name}`,
  repository: "https://github.com/SO4-Markets/interface",
  schema: {
    file: "./schema.graphql",
  },
  network: {
    /* Stellar and Soroban uses the network passphrase as the chainId
      'Test SDF Network ; September 2015' for testnet
      'Public Global Stellar Network ; September 2015' for mainnet
      'Test SDF Future Network ; October 2022' for Future Network */
    chainId,
    /**
     * These endpoint(s) should be public non-pruned archive node
     * We recommend providing more than one endpoint for improved reliability, performance, and uptime
     * Public nodes may be rate limited, which can affect indexing speed
     * When developing your project we suggest getting a private API key
     * If you use a rate limited endpoint, adjust the --batch-size and --workers parameters
     * These settings can be found in your docker-compose.yaml, they will slow indexing but prevent your project being rate limited
     */
    endpoint: endpoint.split(",").map((value) => value.trim()),
    /* This is a specific Soroban endpoint
      It is only required when you are using a soroban/EventHandler */
    sorobanEndpoint,
  },
  dataSources: [
    {
      kind: StellarDatasourceKind.Runtime,
      /* Set this as a logical start block, it might be block 1 (genesis) or when your contract was deployed */
      startBlock: 228206,
      mapping: {
        file: "./dist/index.js",
        handlers: [
          ...indexedContractIds.map((contractId) => ({
            handler: "handleEvent",
            kind: StellarHandlerKind.Event,
            filter: {
              contractId,
            },
          })),
        ],
      },
    },
  ],
}

// Must set default to the project instance
export default project

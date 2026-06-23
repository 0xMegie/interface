import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import os from "os"
import path from "path"

type EnvMap = Record<string, string>

type ContractConfig = {
  source: {
    contractsRepo: string
    files: string[]
  }
  network: {
    name: string
    passphrase: string
    horizonUrl: string
    sorobanRpcUrl: string
  }
  contracts: Record<string, string>
  tokens: Record<string, string>
  markets: MarketConfig[]
}

type MarketConfig = {
  name: string
  marketToken: string
  indexToken: string
  longToken: string
  shortToken: string
}

const INDEXER_ROOT = path.resolve(__dirname, "..")
const REPO_ROOT = path.resolve(INDEXER_ROOT, "../..")

const CORE_CONTRACTS: Record<string, string> = {
  role_store: "ROLE_STORE",
  data_store: "DATA_STORE",
  oracle: "ORACLE",
  market_factory: "MARKET_FACTORY",
  deposit_handler: "DEPOSIT_HANDLER",
  withdrawal_handler: "WITHDRAWAL_HANDLER",
  order_handler: "ORDER_HANDLER",
  liquidation_handler: "LIQUIDATION_HANDLER",
  adl_handler: "ADL_HANDLER",
  fee_handler: "FEE_HANDLER",
  referral_storage: "REFERRAL_STORAGE",
  reader: "READER",
  exchange_router: "EXCHANGE_ROUTER",
}

const TOKEN_CONTRACTS: Record<string, string[]> = {
  TUSDC: ["TOKEN_TUSDC", "TUSDC", "TUSDC_NATIVE"],
  TWBTC: ["TOKEN_TWBTC", "TWBTC", "TWBTC_NATIVE"],
  TETH: ["TOKEN_TETH", "TETH", "TETH_NATIVE"],
  TXLM: ["TOKEN_TXLM", "TXLM", "TXLM_NATIVE"],
  faucet: ["FAUCET"],
}

const DEFAULT_MARKETS = ["TWBTC_TUSDC", "TETH_TUSDC", "TXLM_TUSDC"]

const NETWORK_DEFAULTS: Record<
  string,
  { passphrase: string; horizonUrl: string; sorobanRpcUrl: string }
> = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  },
  local: {
    passphrase: "Standalone Network ; February 2017",
    horizonUrl: "http://localhost:8000",
    sorobanRpcUrl: "http://localhost:8000/soroban/rpc",
  },
}

function usage(): never {
  throw new Error(
    [
      "Usage: bun run scripts/sync-contracts.ts --network <testnet|local> [--contracts-repo <path>] [--allow-missing-markets]",
      "",
      "Environment overrides:",
      "  CONTRACTS_REPO_PATH   Path to the contracts repo",
      "  HORIZON_URL           Horizon endpoint to write into the generated config",
      "  SOROBAN_RPC_URL       Soroban RPC endpoint to write into the generated config",
      "  NETWORK_PASSPHRASE    Network passphrase to write into the generated config",
    ].join("\n")
  )
}

function parseArgs(argv: string[]) {
  const result: {
    network?: string
    contractsRepo?: string
    allowMissingMarkets: boolean
  } = {
    allowMissingMarkets: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--network") {
      result.network = argv[++index]
    } else if (arg === "--contracts-repo") {
      result.contractsRepo = argv[++index]
    } else if (arg === "--allow-missing-markets") {
      result.allowMissingMarkets = true
    } else if (arg === "--help" || arg === "-h") {
      usage()
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!result.network) {
    usage()
  }

  return result as {
    network: string
    contractsRepo?: string
    allowMissingMarkets: boolean
  }
}

function resolveContractsRepo(cliPath?: string): string {
  const candidates = [
    cliPath,
    process.env.CONTRACTS_REPO_PATH,
    path.resolve(REPO_ROOT, "../contracts"),
    path.resolve(REPO_ROOT, "../so4-market-project/contracts"),
    path.resolve(os.homedir(), "zero/so4-market-project/contracts"),
  ].filter(Boolean) as string[]

  const match = candidates.find((candidate) => existsSync(candidate))
  if (!match) {
    throw new Error(
      [
        "Could not find the contracts repo.",
        "Tried:",
        ...candidates.map((candidate) => `  - ${candidate}`),
        "Set CONTRACTS_REPO_PATH or pass --contracts-repo <path>.",
      ].join("\n")
    )
  }

  return path.resolve(match)
}

function readEnvFile(filePath: string, required: boolean): EnvMap {
  if (!existsSync(filePath)) {
    if (required) {
      throw new Error(`Missing deployment file: ${filePath}`)
    }
    return {}
  }

  const env: EnvMap = {}
  const contents = readFileSync(filePath, "utf8")
  for (const [lineNumber, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const separator = line.indexOf("=")
    if (separator === -1) {
      throw new Error(`${filePath}:${lineNumber + 1} is not KEY=VALUE syntax`)
    }

    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }

  return env
}

function readContractIds(filePath: string): EnvMap {
  if (!existsSync(filePath)) {
    return {}
  }

  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    contracts?: Record<string, string>
    network_passphrase?: string
    network?: string
  }

  const env: EnvMap = {}
  for (const [key, value] of Object.entries(parsed.contracts ?? {})) {
    env[key.toUpperCase()] = value
  }
  if (parsed.network_passphrase) {
    env.NETWORK_PASSPHRASE = parsed.network_passphrase
  }
  if (parsed.network) {
    env.NETWORK = parsed.network
  }

  return env
}

function mergeEnv(...sources: EnvMap[]): EnvMap {
  return Object.assign({}, ...sources)
}

function requireValue(env: EnvMap, keys: string[], label: string): string {
  const key = keys.find((candidate) => env[candidate])
  if (!key) {
    throw new Error(`Missing ${label}. Expected one of: ${keys.join(", ")}`)
  }
  return env[key]
}

function contractIdIsValid(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value)
}

function requireContractId(env: EnvMap, keys: string[], label: string): string {
  const value = requireValue(env, keys, label)
  if (!contractIdIsValid(value)) {
    throw new Error(
      `Malformed contract ID for ${label}: ${value}. Expected a Stellar contract ID beginning with C and 56 chars long.`
    )
  }
  return value
}

function buildCoreContracts(env: EnvMap): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CORE_CONTRACTS).map(([name, envKey]) => [
      name,
      requireContractId(env, [envKey], `core contract ${name}`),
    ])
  )
}

function buildTokens(env: EnvMap): Record<string, string> {
  return Object.fromEntries(
    Object.entries(TOKEN_CONTRACTS).map(([name, envKeys]) => [
      name,
      requireContractId(env, envKeys, `token contract ${name}`),
    ])
  )
}

function buildMarkets(
  env: EnvMap,
  allowMissingMarkets: boolean
): MarketConfig[] {
  const markets: MarketConfig[] = []
  const missing: string[] = []

  for (const market of DEFAULT_MARKETS) {
    const baseKey = `MARKET_TOKEN_${market}`
    const requiredKeys = [
      baseKey,
      `${baseKey}_INDEX`,
      `${baseKey}_LONG`,
      `${baseKey}_SHORT`,
    ]

    const missingForMarket = requiredKeys.filter((key) => !env[key])
    if (missingForMarket.length > 0) {
      missing.push(...missingForMarket)
      continue
    }

    markets.push({
      name: market.replace("_", "/"),
      marketToken: requireContractId(env, [baseKey], `market ${market}`),
      indexToken: requireContractId(
        env,
        [`${baseKey}_INDEX`],
        `${market} index token`
      ),
      longToken: requireContractId(
        env,
        [`${baseKey}_LONG`],
        `${market} long token`
      ),
      shortToken: requireContractId(
        env,
        [`${baseKey}_SHORT`],
        `${market} short token`
      ),
    })
  }

  if (missing.length > 0 && !allowMissingMarkets) {
    throw new Error(
      [
        "Missing market bootstrap values:",
        ...missing.map((key) => `  - ${key}`),
        "Run the contracts bootstrap/export step, or pass --allow-missing-markets before markets are bootstrapped.",
      ].join("\n")
    )
  }

  if (missing.length > 0) {
    console.warn(
      [
        "Market token values are missing; writing pre-bootstrap config without markets:",
        ...missing.map((key) => `  - ${key}`),
      ].join("\n")
    )
  }

  return markets
}

function buildConfig(args: ReturnType<typeof parseArgs>): ContractConfig {
  const contractsRepo = resolveContractsRepo(args.contractsRepo)
  const network = args.network
  const defaults = NETWORK_DEFAULTS[network] ?? NETWORK_DEFAULTS.testnet

  const deploymentEnvPath = path.join(
    contractsRepo,
    ".deployed",
    `${network}.env`
  )
  const tokensEnvPath = path.join(
    contractsRepo,
    ".deployed",
    `tokens-${network}.env`
  )
  const frontendEnvPath = path.join(
    contractsRepo,
    ".deployed",
    `frontend-${network}.env`
  )
  const contractIdsPath = path.join(
    contractsRepo,
    ".stellar",
    "contract-ids",
    `${network}.json`
  )

  const deploymentEnv = readEnvFile(deploymentEnvPath, true)
  const tokenEnv = readEnvFile(tokensEnvPath, false)
  const frontendEnv = readEnvFile(frontendEnvPath, false)
  const contractIds = readContractIds(contractIdsPath)
  const env = mergeEnv(contractIds, frontendEnv, tokenEnv, deploymentEnv, {
    NETWORK: network,
    NETWORK_PASSPHRASE:
      process.env.NETWORK_PASSPHRASE ??
      deploymentEnv.NETWORK_PASSPHRASE ??
      contractIds.NETWORK_PASSPHRASE ??
      defaults.passphrase,
    HORIZON_URL:
      process.env.HORIZON_URL ??
      deploymentEnv.HORIZON_URL ??
      defaults.horizonUrl,
    SOROBAN_RPC_URL:
      process.env.SOROBAN_RPC_URL ??
      deploymentEnv.SOROBAN_RPC_URL ??
      deploymentEnv.RPC_URL ??
      defaults.sorobanRpcUrl,
  })

  return {
    source: {
      contractsRepo,
      files: [
        deploymentEnvPath,
        tokensEnvPath,
        frontendEnvPath,
        contractIdsPath,
      ].filter((file) => existsSync(file)),
    },
    network: {
      name: requireValue(env, ["NETWORK"], "network name"),
      passphrase: requireValue(
        env,
        ["NETWORK_PASSPHRASE"],
        "network passphrase"
      ),
      horizonUrl: requireValue(env, ["HORIZON_URL"], "Horizon endpoint"),
      sorobanRpcUrl: requireValue(
        env,
        ["SOROBAN_RPC_URL"],
        "Soroban RPC endpoint"
      ),
    },
    contracts: buildCoreContracts(env),
    tokens: buildTokens(env),
    markets: buildMarkets(env, args.allowMissingMarkets),
  }
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    const config = buildConfig(args)
    const configDir = path.join(INDEXER_ROOT, "config")
    const outputPath = path.join(configDir, `contracts.${args.network}.json`)

    mkdirSync(configDir, { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)

    console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`)
    console.log(
      `Synced ${Object.keys(config.contracts).length} core contracts, ${Object.keys(config.tokens).length} token contracts, and ${config.markets.length} markets for ${config.network.name}.`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main()

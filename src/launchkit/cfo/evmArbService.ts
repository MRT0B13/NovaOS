/**
 * EVM Flash Arbitrage Service — Multi-chain
 *
 * Scans Arbitrum, Base, Polygon, and Optimism for atomic flash loan arb
 * opportunities across multiple DEX venues per chain.
 *
 * Pool list: built from DeFiLlama yields API (public, no auth).
 *   Endpoint: https://yields.llama.fi/pools
 *   Filter: chain ∈ enabled chains, project ∈ per-chain venue list, tvlUsd > MIN_POOL_TVL_USD
 *   Refresh: every CFO_EVM_ARB_POOL_REFRESH_MS (default 4h)
 *
 * Quoting: direct on-chain staticCall to QuoterV2 per venue.
 * Execution: ArbFlashReceiver.sol via Aave v3 flashLoanSimple().
 *
 * Key invariant: this module never holds or moves the EVM wallet's balance.
 * All capital is Aave's for the duration of one transaction.
 */

import { logger } from '@elizaos/core';
import { getCFOEnv } from './cfoEnv.ts';

// ============================================================================
// Embedded ArbFlashReceiver contract artifacts (solc 0.8.20 --via-ir)
// Avoids filesystem dependency on contracts/out/ (not available on Railway)
// ============================================================================

const ARBFLASH_ABI = [{"inputs":[{"internalType":"address","name":"aaveAddressesProvider","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"BALANCER_VAULT","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"DEX_BALANCER","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"DEX_CAMELOT_V3","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"DEX_UNISWAP_V3","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"aavePool","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"asset","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"premium","type":"uint256"},{"internalType":"address","name":"initiator","type":"address"},{"internalType":"bytes","name":"params","type":"bytes"}],"name":"executeOperation","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"asset","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"bytes","name":"params","type":"bytes"}],"name":"requestFlashLoan","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"rescueToken","outputs":[],"stateMutability":"nonpayable","type":"function"},{"stateMutability":"payable","type":"receive"}] as const;

const ARBFLASH_BYTECODE = '0x60c08060405234620000ed576020620000346004926200124f8038038091620000298285620000f1565b833981019062000129565b3360805260405163026b1d5f60e01b815292839182906001600160a01b03165afa908115620000e2575f91620000ad575b5060a05260405161110490816200014b823960805181818161011b015281816101be0152818161033701526105f2015260a05181818160d801528181610248015261043f0152f35b620000d3915060203d8111620000da575b620000ca8183620000f1565b81019062000129565b5f62000065565b503d620000be565b6040513d5f823e3d90fd5b5f80fd5b601f909101601f19168101906001600160401b038211908210176200011557604052565b634e487b7160e01b5f52604160045260245ffd5b90816020910312620000ed57516001600160a01b0381168103620000ed579056fe6080604081815260049182361015610021575b505050361561001f575f80fd5b005b5f92833560e01c918263142b49431461076b575081631b11d0ff146103e957816333f3d628146103145781633c152cf5146102f95781635107d61e146101655750806367cf4edc1461014a5780638da5cb5b14610107578063a03e4bc3146100c45763bc163846146100935780610012565b346100c057816003193601126100c0576020905173ba12222222228d8ba445958a75a0704d566bf2c88152f35b5080fd5b50346100c057816003193601126100c057517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b50346100c057816003193601126100c057517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b50346100c057816003193601126100c0576020905160028152f35b919050346102f55760603660031901126102f557610181610786565b67ffffffffffffffff90846044358381116100c057601f9260e46102436101ac859436908b016107a0565b9092906001600160a01b03906101e5337f00000000000000000000000000000000000000000000000000000000000000008416146107ce565b808b5195869360208501986310ac2ddf60e21b8a52306024870152166044850152602435606485015260a060848501528160c485015284840137868382840101528660a48301528819988991011681010360c48101845201826108a7565b5190827f00000000000000000000000000000000000000000000000000000000000000005af1913d156102ee573d9081116102db5761028c6020855193601f84011601836108a7565b81528460203d92013e5b1561029f578280f35b906020606492519162461bcd60e51b83528201526016602482015275199b185cda131bd85b94da5b5c1b194819985a5b195960521b6044820152fd5b634e487b7160e01b865260418552602486fd5b5050610296565b8280fd5b5050346100c057816003193601126100c05751908152602090f35b919050346102f557806003193601126102f55760206103a092610335610786565b7f0000000000000000000000000000000000000000000000000000000000000000866001600160a01b0361036c33828516146107ce565b865163a9059cbb60e01b81526001600160a01b03909316948301948552602435602086015291968794859391849160400190565b0393165af19081156103e057506103b5575080f35b6103d59060203d81116103d9575b6103cd81836108a7565b8101906108c9565b5080f35b503d6103c3565b513d84823e3d90fd5b9050346102f55760a03660031901126102f557610404610786565b926001600160a01b03606435818116908190036102f55760843567ffffffffffffffff81116107015761043a90369086016107a0565b9290927f000000000000000000000000000000000000000000000000000000000000000092828416330361073857300361070557836101409161047b6108e1565b506104846108e1565b5081010312610701578061049784610905565b9760208099898760ff6104ab858301610919565b876104b860608501610927565b946104c560808601610905565b97846104d360a08801610919565b94846104ee6101006104e760e08c01610927565b9a01610905565b169984519e8f916104fe83610806565b16905216908c0152808d0135818c015262ffffff80961660608c0152519661052588610806565b168652168d85015260c08901358c8501521660608301526024356044358101958682116106ee578261055f61056595938995888095610937565b92610d13565b838111156106e3578381039081116106d05761012090955b0135851061069757875163095ea7b360e01b81526001600160a01b039094168785019081526020810193909352169190879082908190604001038187865af1801561068d579087939291610670575b50816105dc575b82865160018152f35b855163a9059cbb60e01b81526001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000169581019586526020860192909252909384919082908590829060400103925af19081156106655750610648575b808381806105d3565b61065e90833d85116103d9576103cd81836108a7565b505f61063f565b8351903d90823e3d90fd5b61068690843d86116103d9576103cd81836108a7565b505f6105cc565b86513d86823e3d90fd5b875162461bcd60e51b81528088018a905260136024820152721a5b9cdd59999a58da595b9d081c1c9bd99a5d606a1b6044820152606490fd5b634e487b7160e01b875260118852602487fd5b50610120869561057d565b634e487b7160e01b8a5260118b5260248afd5b8380fd5b865162461bcd60e51b8152602081880152600d60248201526c3130b21034b734ba34b0ba37b960991b6044820152606490fd5b875162461bcd60e51b8152602081890152600d60248201526c1b9bdd0810585d99481c1bdbdb609a1b6044820152606490fd5b8490346100c057816003193601126100c05780600160209252f35b600435906001600160a01b038216820361079c57565b5f80fd5b9181601f8401121561079c5782359167ffffffffffffffff831161079c576020838186019501011161079c57565b156107d557565b60405162461bcd60e51b81526020600482015260096024820152683737ba1037bbb732b960b91b6044820152606490fd5b6080810190811067ffffffffffffffff82111761082257604052565b634e487b7160e01b5f52604160045260245ffd5b60c0810190811067ffffffffffffffff82111761082257604052565b60e0810190811067ffffffffffffffff82111761082257604052565b610100810190811067ffffffffffffffff82111761082257604052565b6020810190811067ffffffffffffffff82111761082257604052565b90601f8019910116810190811067ffffffffffffffff82111761082257604052565b9081602091031261079c5751801515810361079c5790565b604051906108ee82610806565b5f6060838281528260208201528260408201520152565b35906001600160a01b038216820361079c57565b359060ff8216820361079c57565b359062ffffff8216820361079c57565b80516040805163095ea7b360e01b81526001600160a01b0392831660048201526024810187905290959493909116906020816044815f865af18015610d0957610cea575b50602082015160ff1680610a9457506020925f62ffffff95936101049387606060018060a01b0384511693015116958951916109b68361086e565b82526001600160a01b039485168883019081528a83019788523060608401908152426080850190815260a0850193845260c0850187815260e086018881528e5163414bf38960e01b815296518a1660048801529351891660248701529951909b1660448501525186166064840152985160848301525160a4820152945160c4860152955190911660e48401529193849283915af1918215610a8b57505f91610a5c575090565b90506020813d602011610a83575b81610a77602093836108a7565b8101031261079c575190565b3d9150610a6a565b513d5f823e3d90fd5b909190600103610b54575184516020939260e4925f916001600160a01b0390911690610abf84610852565b83526001600160a01b0394851686840190815230898501908152426060860190815260808601998a5260a0860185815260c087018681528c5163178ca23160e31b815297518a16600489015293518916602488015291518816604487015251606486015297516084850152965160a4840152955190931660c482015293849283915af1918215610a8b57505f91610a5c575090565b938093919594015191835192610b6984610836565b8352602083015f8152848401968752606084019160018060a01b03168252608084019283528451610b998161088b565b5f815260a08501908152855193610baf85610806565b30855260208501935f855287860199308b5260608701945f86528951986352bbbe2960e01b8a5260e060048b01525160e48a0152516002811015610cd657610104890152516001600160a01b03908116610124890152905116610144870152516101648601525160c061018486015280516101a48601819052909790925f5b848110610cbf575085969798509185949391602096936101c4955f87868801015260018060a01b039051166024860152511515604485015260018060a01b03905116606484015251151560848301525f60a48301524260c4830152601f801991011681010301815f73ba12222222228d8ba445958a75a0704d566bf2c85af1918215610a8b57505f91610a5c575090565b80602080928c0101516101c4828a01015201610c2e565b634e487b7160e01b5f52602160045260245ffd5b610d029060203d6020116103d9576103cd81836108a7565b505f61097b565b86513d5f823e3d90fd5b805160405163095ea7b360e01b81526001600160a01b03909116600482015260248101859052919594909390929091602081806044810103815f6001600160a01b038c165af18015610e4c576110af575b50602084015160ff1680610e5757509460209392610104925f969762ffffff606060018060a01b03885116970151169060405194610da18661086e565b6001600160a01b03908116865290811688860190815260408087019384523060608801908152426080890190815260a0890196875260c0890197885260e089018d8152925163414bf38960e01b81529851851660048a0152925184166024890152935162ffffff166044880152925182166064870152516084860152915160a4850152915160c484015290511660e48201529384928391905af1908115610e4c575f91610a5c575090565b6040513d5f823e3d90fd5b92939092600103610f1e57945f60e492602095969760018060a01b039051169060405193610e8485610852565b6001600160a01b03908116855295861687850190815230604080870191825242606088019081526080880194855260a088019b8c5260c08801878152915163178ca23160e31b815297518a1660048901529251891660248801529051881660448701529051606486015290516084850152965160a4840152955190931660c482015293849283915af1908115610e4c575f91610a5c575090565b60409092919201519260405193610f3485610836565b84525f602085019081526001600160a01b0396871660408087019182529390971660608601908152608086019485529251610f6e8161088b565b5f815260a0860190815260405194610f8586610806565b30865260208601945f86526040870199308b5260608801945f8652604051996352bbbe2960e01b8b5260e060048c01525160e48b0152516002811015610cd6576101048a0152516001600160a01b039081166101248a0152905116610144880152516101648701525160c061018487015280516101a48701819052909790935f5b85811061109857505f6101c4888701810182905296516001600160a01b0390811660248a0152915115156044890152915116606487015290511515608486015260a48501919091524260c485015293945091926020928492601f909101601f191683018390030190829073ba12222222228d8ba445958a75a0704d566bf2c85af1908115610e4c575f91610a5c575090565b80602080928c0101516101c4828b01015201611006565b6110c79060203d6020116103d9576103cd81836108a7565b505f610d6456fea26469706673582212202eccedcd7d3dfbe27fef8d72ecc750150479ed47b6237ec6b527c07ff0c99f9a64736f6c63430008140033';

// ============================================================================
// Multi-chain Configuration
// ============================================================================

/** Venue definition — router, quoter, factory addresses for one DEX on one chain */
interface VenueConfig {
  dex: DexId;
  llamaProject: string;     // DeFiLlama project identifier
  router: string;
  quoter: string;
  factory: string;
  maxPools: number;          // max pools to fetch from DeFiLlama
  isAlgebra?: boolean;       // true for Camelot/Algebra (dynamic fee, poolByPair)
}

/** Per-chain configuration for arb scanning */
interface ChainConfig {
  chainId: number;
  name: string;              // display name
  llamaChain: string;        // DeFiLlama chain name (e.g. "Arbitrum", "Base")
  balancerApiChain: string;  // Balancer API chain enum (e.g. "ARBITRUM", "BASE")
  aavePool: string;          // Aave V3 Pool address (same across most chains)
  balancerVault: string;     // Balancer Vault (same across most chains)
  venues: VenueConfig[];
  /** Tokens that Aave V3 supports for flash loans on this chain */
  aaveListedTokens: Set<string>;
  /** Bridge tokens for triangular arb scanning */
  bridgeTokens: Set<string>;
  /** Typical gas for a 2-swap arb in gas units */
  gasUnits2Swap: number;
  /** Typical gas for a 3-swap triangular arb in gas units */
  gasUnits3Swap: number;
  /** Minimum net profit (USD) to trigger execution. Lower for cheap L2s. */
  minProfitUsd: number;
}

// ── Shared addresses across chains ─────────────────────────────────────────
// Uniswap V3, SushiSwap V3, Balancer, and Aave V3 use canonical deployments
const UNISWAP_V3_ROUTER_CANONICAL  = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const UNISWAP_V3_QUOTER_CANONICAL  = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const UNISWAP_V3_FACTORY_CANONICAL = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const SUSHI_V3_ROUTER_CANONICAL    = '0x8A21F6768C1f8075791D08546Dadf6daA0bE820c';
const SUSHI_V3_QUOTER_CANONICAL    = '0x64e8802FE490fa7cc61d3c28aFD1A750d0689A07'; // V3 QuoterV2 on most chains
const SUSHI_V3_FACTORY_CANONICAL   = '0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e';
const BALANCER_VAULT_CANONICAL     = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const AAVE_V3_POOL_CANONICAL       = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

// ── Chain configs ──────────────────────────────────────────────────────────

const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum',
    llamaChain: 'Arbitrum',
    balancerApiChain: 'ARBITRUM',
    aavePool: AAVE_V3_POOL_CANONICAL,
    balancerVault: BALANCER_VAULT_CANONICAL,
    venues: [
      { dex: 'uniswap_v3', llamaProject: 'uniswap-v3', router: UNISWAP_V3_ROUTER_CANONICAL, quoter: UNISWAP_V3_QUOTER_CANONICAL, factory: UNISWAP_V3_FACTORY_CANONICAL, maxPools: 80 },
      { dex: 'camelot_v3', llamaProject: 'camelot-v3', router: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d', quoter: '', factory: '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B', maxPools: 40, isAlgebra: true },
      { dex: 'pancake_v3', llamaProject: 'pancakeswap-amm-v3', router: '0x32226588378236Fd0c7c4053999F88aC0e5cAc77', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', maxPools: 30 },
      { dex: 'sushi_v3', llamaProject: 'sushiswap-v3', router: SUSHI_V3_ROUTER_CANONICAL, quoter: '0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1', factory: SUSHI_V3_FACTORY_CANONICAL, maxPools: 30 },
      { dex: 'ramses_v2', llamaProject: 'ramses-v2', router: '0xAA23611badAFB62D37E7295A682D21960ac85A90', quoter: '0xAA20e84a61d5E3C1aA5fc8b1dB0B0FcEFf4015E3', factory: '0xAA2cd7477c451E703f3B9Ba5663334914763edF8', maxPools: 30 },
    ],
    aaveListedTokens: new Set([
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
      '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', // WBTC
      '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
      '0xf97f4df75117a78c1a5a0dbb814af92458539fb4', // LINK
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    ]),
    bridgeTokens: new Set([
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
      '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', // WBTC
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    ]),
    gasUnits2Swap: 800_000,
    gasUnits3Swap: 1_200_000,
    minProfitUsd: 0.50,
  },

  base: {
    chainId: 8453,
    name: 'Base',
    llamaChain: 'Base',
    balancerApiChain: 'BASE',
    aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', // Aave V3 on Base
    balancerVault: BALANCER_VAULT_CANONICAL,
    venues: [
      { dex: 'uniswap_v3', llamaProject: 'uniswap-v3', router: '0x2626664c2603336E57B271c5C0b26F421741e481', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', maxPools: 80 },
      { dex: 'pancake_v3', llamaProject: 'pancakeswap-amm-v3', router: '0x678Aa4e4fD66a8E35d4a7Fe7e5D2d5B6Da89A485', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', maxPools: 30 },
      { dex: 'sushi_v3', llamaProject: 'sushiswap-v3', router: '0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f', quoter: SUSHI_V3_QUOTER_CANONICAL, factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', maxPools: 30 },
      // Aerodrome (Velodrome fork on Base) — Algebra-style, dynamic fees
      { dex: 'camelot_v3', llamaProject: 'aerodrome-v2', router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', quoter: '', factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', maxPools: 50, isAlgebra: true },
    ],
    aaveListedTokens: new Set([
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
      '0x4200000000000000000000000000000000000006', // WETH
      '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', // cbETH
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
    ]),
    bridgeTokens: new Set([
      '0x4200000000000000000000000000000000000006', // WETH
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
      '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
    ]),
    gasUnits2Swap: 500_000,
    gasUnits3Swap: 800_000,
    minProfitUsd: 0.05,
  },

  polygon: {
    chainId: 137,
    name: 'Polygon',
    llamaChain: 'Polygon',
    balancerApiChain: 'POLYGON',
    aavePool: AAVE_V3_POOL_CANONICAL,
    balancerVault: BALANCER_VAULT_CANONICAL,
    venues: [
      { dex: 'uniswap_v3', llamaProject: 'uniswap-v3', router: UNISWAP_V3_ROUTER_CANONICAL, quoter: UNISWAP_V3_QUOTER_CANONICAL, factory: UNISWAP_V3_FACTORY_CANONICAL, maxPools: 80 },
      { dex: 'pancake_v3', llamaProject: 'pancakeswap-amm-v3', router: '0x32226588378236Fd0c7c4053999F88aC0e5cAc77', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', maxPools: 30 },
      { dex: 'sushi_v3', llamaProject: 'sushiswap-v3', router: '0x0f1480eE0020e0582592668B0E39e4A7A29E939c', quoter: SUSHI_V3_QUOTER_CANONICAL, factory: '0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2', maxPools: 30 },
      // QuickSwap V3 (Algebra fork — dynamic fee)
      { dex: 'camelot_v3', llamaProject: 'quickswap-dex', router: '0xf5b509bB0909a69B1c207E495f687a596C168E12', quoter: '', factory: '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28', maxPools: 40, isAlgebra: true },
    ],
    aaveListedTokens: new Set([
      '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC native
      '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH
      '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', // WBTC
      '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // WMATIC
      '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39', // LINK
      '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
    ]),
    bridgeTokens: new Set([
      '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH
      '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC
      '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // WMATIC
      '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', // WBTC
    ]),
    gasUnits2Swap: 800_000,
    gasUnits3Swap: 1_200_000,
    minProfitUsd: 1.00,
  },

  optimism: {
    chainId: 10,
    name: 'Optimism',
    llamaChain: 'Optimism',
    balancerApiChain: 'OPTIMISM',
    aavePool: AAVE_V3_POOL_CANONICAL,
    balancerVault: BALANCER_VAULT_CANONICAL,
    venues: [
      { dex: 'uniswap_v3', llamaProject: 'uniswap-v3', router: UNISWAP_V3_ROUTER_CANONICAL, quoter: UNISWAP_V3_QUOTER_CANONICAL, factory: UNISWAP_V3_FACTORY_CANONICAL, maxPools: 80 },
      { dex: 'sushi_v3', llamaProject: 'sushiswap-v3', router: SUSHI_V3_ROUTER_CANONICAL, quoter: SUSHI_V3_QUOTER_CANONICAL, factory: SUSHI_V3_FACTORY_CANONICAL, maxPools: 30 },
      // Velodrome CL (Algebra-style, dynamic fee)
      { dex: 'camelot_v3', llamaProject: 'velodrome-v2', router: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858', quoter: '', factory: '0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F', maxPools: 50, isAlgebra: true },
    ],
    aaveListedTokens: new Set([
      '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC native
      '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC.e
      '0x4200000000000000000000000000000000000006', // WETH
      '0x68f180fcce6836688e9084f035309e29bf0a2095', // WBTC
      '0x4200000000000000000000000000000000000042', // OP
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    ]),
    bridgeTokens: new Set([
      '0x4200000000000000000000000000000000000006', // WETH
      '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
      '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC.e
      '0x68f180fcce6836688e9084f035309e29bf0a2095', // WBTC
    ]),
    gasUnits2Swap: 500_000,
    gasUnits3Swap: 800_000,
    minProfitUsd: 0.05,
  },
};

/** Aave V3 PoolAddressesProvider per chain (constructor arg for ArbFlashReceiver) */
const AAVE_ADDRESSES_PROVIDER: Record<string, string> = {
  arbitrum: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  base:     '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
  polygon:  '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  optimism: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
};

/** Get list of enabled chain keys from env (default: arbitrum only) */
function getEnabledChains(): ChainConfig[] {
  const env = getCFOEnv();
  const keys = env.evmArbChains.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return keys.map(k => CHAIN_CONFIGS[k]).filter(Boolean);
}

// Aave v3 flash loan fee: 0.05%
const AAVE_FLASH_FEE_BPS = 5;

// DEX type — must match Solidity contract constants exactly
const DEX_UNISWAP_V3 = 0;
const DEX_CAMELOT_V3 = 1;
const DEX_BALANCER   = 2;
const DEX_SUSHI_V3   = 3;
const DEX_RAMSES_V2  = 4;
type DexType = typeof DEX_UNISWAP_V3 | typeof DEX_CAMELOT_V3 | typeof DEX_BALANCER | typeof DEX_SUSHI_V3 | typeof DEX_RAMSES_V2;

// Minimum pool TVL to include in candidate list ($50k — lower threshold catches
// mid-cap pairs with wider spreads that major arb bots ignore)
const MIN_POOL_TVL_USD = 50_000;

// Flash loan sizes: scale with pool TVL. Cap at env.evmArbMaxFlashUsd.
// 12% captures more spread per trade while staying within safe price-impact range
// for concentrated liquidity pools (V3-style). Old value was 5%.
const FLASH_AMOUNT_FRACTION = 0.12;

// ============================================================================
// Types
// ============================================================================

export type DexId = 'uniswap_v3' | 'camelot_v3' | 'pancake_v3' | 'sushi_v3' | 'ramses_v2' | 'balancer';

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * A single liquidity pool on one venue.
 * Built from DeFiLlama discovery + on-chain metadata fetch.
 */
export interface CandidatePool {
  poolAddress: string;        // EVM pool contract address
  poolId: string;             // bytes32 Balancer pool id (zero for Uni/Camelot)
  dex: DexId;
  dexType: DexType;
  router: string;
  quoter: string;
  token0: TokenMeta;
  token1: TokenMeta;
  feeTier: number;            // Uni v3: 500/3000/10000. Camelot: 0 (dynamic). Balancer: 0.
  tvlUsd: number;
  flashAmountUsd: number;     // computed flash size for this pool
  pairKey: string;            // canonical e.g. "0xabc...123_0xdef...456" (lower address first)
  chainKey: string;           // e.g. "arbitrum", "base", "polygon", "optimism"
}

export interface ArbOpportunity {
  pairKey: string;
  displayPair: string;          // e.g. "USDC/WETH"
  flashLoanAsset: string;       // address of token to borrow from Aave
  flashLoanSymbol: string;
  flashAmountRaw: bigint;
  flashAmountUsd: number;
  buyPool: CandidatePool;
  sellPool: CandidatePool;
  tokenOut: TokenMeta;          // intermediate token
  expectedGrossUsd: number;
  aaveFeeUsd: number;
  gasEstimateUsd: number;
  netProfitUsd: number;
  chainKey: string;           // which chain this opportunity is on
  detectedAt: number;
}

export interface ArbResult {
  success: boolean;
  txHash?: string;
  profitUsd?: number;
  error?: string;
}

// ============================================================================
// ABI Fragments
// ============================================================================

// Uniswap v3 QuoterV2 — struct-based input (V2 ABI, NOT the flat-param V1 ABI)
const UNI_QUOTER_ABI = [
  `function quoteExactInputSingle(
    tuple(
      address tokenIn, address tokenOut,
      uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96
    ) params
  ) external returns (
    uint256 amountOut, uint160 sqrtPriceX96After,
    uint32 initializedTicksCrossed, uint256 gasEstimate
  )`,
];

// Balancer queryBatchSwap — GIVEN_IN = 0
const BALANCER_VAULT_ABI = [
  `function queryBatchSwap(
    uint8 kind,
    tuple(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
    address[] assets,
    tuple(address sender, bool fromInternalBalance, address payable recipient, bool toInternalBalance) funds
  ) external returns (int256[] memory)`,
];

// ERC20 + Uniswap pool metadata
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

const UNI_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee()    view returns (uint24)',
];

// ArbFlashReceiver
const RECEIVER_ABI = [
  'function requestFlashLoan(address asset, uint256 amount, bytes calldata params) external',
];

// ============================================================================
// Multi-chain provider management (lazy init, one provider per chain)
// ============================================================================

let _ethers: any = null;
const _providers = new Map<number, any>();   // chainId → JsonRpcProvider
const _wallets   = new Map<number, any>();   // chainId → Wallet

async function loadChain(chainId: number): Promise<{ provider: any; wallet: any; ethers: any }> {
  if (!_ethers) {
    const mod = await import('ethers');
    _ethers = mod.ethers ?? mod;
  }

  if (_wallets.has(chainId)) {
    return { provider: _providers.get(chainId), wallet: _wallets.get(chainId), ethers: _ethers };
  }

  const env = getCFOEnv();
  if (!env.evmPrivateKey) throw new Error('[ArbMonitor] CFO_EVM_PRIVATE_KEY not set');

  const rpcUrl = env.evmRpcUrls[chainId];
  if (!rpcUrl) throw new Error(`[ArbMonitor] No RPC URL for chainId ${chainId}`);

  const provider = new _ethers.JsonRpcProvider(rpcUrl);
  const wallet = new _ethers.Wallet(env.evmPrivateKey, provider);

  _providers.set(chainId, provider);
  _wallets.set(chainId, wallet);

  logger.info(`[ArbMonitor] Chain ${chainId} provider: ${rpcUrl.replace(/\/v2\/.*/, '/v2/***')}`);
  if (_wallets.size === 1) logger.info(`[ArbMonitor] Wallet: ${wallet.address}`);

  return { provider, wallet, ethers: _ethers };
}

/** Backwards compat — loads Arbitrum provider */
async function loadArb() {
  return loadChain(42161);
}

// ============================================================================
// Pool Discovery — DeFiLlama yields API + on-chain metadata (multi-chain)
// ============================================================================

let _candidatePools: CandidatePool[] = [];
let _poolsRefreshedAt = 0;

/**
 * Fetch top pools from DeFiLlama for all enabled chains, enrich with on-chain metadata.
 * Results cached for evmArbPoolRefreshMs (default 4h).
 */
export async function refreshCandidatePools(): Promise<CandidatePool[]> {
  const env = getCFOEnv();
  const refreshMs = env.evmArbPoolRefreshMs ?? 4 * 3600_000;

  if (_candidatePools.length > 0 && Date.now() - _poolsRefreshedAt < refreshMs) {
    return _candidatePools;
  }

  const enabledChains = getEnabledChains();
  if (enabledChains.length === 0) {
    logger.warn('[ArbMonitor] No chains enabled — set CFO_EVM_ARB_CHAINS');
    return _candidatePools;
  }

  logger.info(`[ArbMonitor] Refreshing pools from DeFiLlama for ${enabledChains.map(c => c.name).join(', ')}...`);

  try {
    // ── Fetch from DeFiLlama (single API call for all chains) ───────────────
    const resp = await fetch('https://yields.llama.fi/pools');
    if (!resp.ok) throw new Error(`DeFiLlama yields API: ${resp.status}`);
    const data = await resp.json() as { status: string; data: any[] };

    const allPools: CandidatePool[] = [];

    // ── Process each enabled chain in parallel ──────────────────────────────
    await Promise.all(enabledChains.map(async (chain) => {
      try {
        const { provider, ethers } = await loadChain(chain.chainId);

        // Build set of DeFiLlama projects for this chain
        const llamaProjects = new Set(chain.venues.map(v => v.llamaProject));

        // Filter DeFiLlama data for this chain
        const raw = data.data.filter((p: any) =>
          p.chain === chain.llamaChain &&
          llamaProjects.has(p.project) &&
          (p.tvlUsd ?? 0) >= MIN_POOL_TVL_USD &&
          Array.isArray(p.underlyingTokens) &&
          p.underlyingTokens.length >= 2
        );

        // Per-venue pool selection — prevents large venues from squeezing out small ones
        const top: any[] = [];
        for (const venue of chain.venues) {
          const venuePools = raw
            .filter((p: any) => p.project === venue.llamaProject)
            .sort((a: any, b: any) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
            .slice(0, venue.maxPools);
          top.push(...venuePools);
        }

        // Venue breakdown for logging
        const venueCounts = chain.venues
          .map(v => {
            const count = top.filter((p: any) => p.project === v.llamaProject).length;
            return count > 0 ? `${count} ${v.dex}` : null;
          })
          .filter(Boolean);

        logger.info(`[ArbMonitor] ${chain.name}: ${raw.length} raw → enriching ${top.length} (${venueCounts.join(' + ')})...`);

        // Enrich with on-chain metadata
        const enriched = await Promise.allSettled(
          top.map((raw: any) => enrichPool(raw, provider, ethers, chain))
        );

        const chainPools: CandidatePool[] = [];
        for (const result of enriched) {
          if (result.status === 'fulfilled' && result.value) {
            chainPools.push(result.value);
          }
        }

        // Balancer pools (if Balancer vault exists for this chain)
        if (chain.balancerVault) {
          const balPools = await fetchBalancerPools(provider, ethers, chain);
          chainPools.push(...balPools);
        }

        logger.info(`[ArbMonitor] ${chain.name}: ${chainPools.length} pools ready across ${new Set(chainPools.map(p => p.dex)).size} venues`);
        allPools.push(...chainPools);

      } catch (err) {
        logger.warn(`[ArbMonitor] ${chain.name} pool discovery failed:`, err);
      }
    }));

    // Summary
    const chainSummary = enabledChains.map(c => {
      const count = allPools.filter(p => p.chainKey === c.name.toLowerCase()).length;
      return `${c.name}:${count}`;
    }).join(' ');
    logger.info(`[ArbMonitor] Pool list ready: ${allPools.length} total | ${chainSummary}`);

    _candidatePools = allPools;
    _poolsRefreshedAt = Date.now();
    return allPools;

  } catch (err) {
    logger.warn('[ArbMonitor] Pool refresh failed, using cached list:', err);
    return _candidatePools;
  }
}

/**
 * Parse DeFiLlama poolMeta fee string to Uniswap v3 fee tier.
 * Examples: "0.01%" → 100, "0.05%" → 500, "0.3%" → 3000, "1%" → 10000
 */
function parsePoolMetaFee(poolMeta: string | undefined): number {
  if (!poolMeta) return 0;
  const match = poolMeta.match(/([\d.]+)%/);
  if (!match) return 0;
  const pct = parseFloat(match[1]);
  if (isNaN(pct) || pct <= 0) return 0;
  return Math.round(pct * 10_000); // 0.05% → 500, 0.3% → 3000
}

/**
 * Enrich a single DeFiLlama pool entry with on-chain token metadata and fee tier.
 * Returns null if the pool can't be used (e.g. missing data, non-ERC20 token).
 */
async function enrichPool(raw: any, provider: any, ethers: any, chain: ChainConfig): Promise<CandidatePool | null> {
  try {
    const env = getCFOEnv();
    const [t0addr, t1addr]: [string, string] = [
      raw.underlyingTokens[0].toLowerCase(),
      raw.underlyingTokens[1].toLowerCase(),
    ];

    // Find venue config for this DeFiLlama project
    const venue = chain.venues.find(v => v.llamaProject === raw.project);
    if (!venue) return null;

    const dex = venue.dex;
    const dexType: DexType = dex === 'uniswap_v3' ? DEX_UNISWAP_V3
      : dex === 'camelot_v3' ? DEX_CAMELOT_V3
      : dex === 'pancake_v3' ? DEX_UNISWAP_V3  // PCS V3 is a Uni V3 fork — same router ABI
      : dex === 'sushi_v3' ? DEX_SUSHI_V3
      : dex === 'ramses_v2' ? DEX_RAMSES_V2
      : DEX_BALANCER;

    // ── Fetch token metadata on-chain ──────────────────────────────────────
    const cacheKey = `${chain.chainId}:`;
    const [t0, t1] = await Promise.all([
      fetchTokenMeta(cacheKey + t0addr, t0addr, provider, ethers),
      fetchTokenMeta(cacheKey + t1addr, t1addr, provider, ethers),
    ]);
    if (!t0 || !t1) return null;

    let feeTier = 0;
    let poolId = ethers.ZeroHash as string;
    let poolAddr = '';

    if (venue.isAlgebra) {
      // Algebra-style (Camelot, QuickSwap, Velodrome CL, Aerodrome): dynamic fee, poolByPair
      const factory = new ethers.Contract(venue.factory, [
        'function poolByPair(address,address) view returns (address)',
      ], provider);
      poolAddr = (await factory.poolByPair(t0addr, t1addr)).toLowerCase();
      if (!poolAddr || poolAddr === ethers.ZeroAddress) return null;
    } else {
      // Uniswap V3 style (Uni, PCS, Sushi, Ramses): fee tier from poolMeta, getPool
      feeTier = parsePoolMetaFee(raw.poolMeta);
      if (feeTier === 0) return null;

      const factory = new ethers.Contract(venue.factory, [
        'function getPool(address,address,uint24) view returns (address)',
      ], provider);
      poolAddr = (await factory.getPool(t0addr, t1addr, feeTier)).toLowerCase();
      if (!poolAddr || poolAddr === ethers.ZeroAddress) return null;
    }

    // ── Compute flash size ─────────────────────────────────────────────────
    const tvlUsd = raw.tvlUsd ?? 0;
    const maxFlash = env.evmArbMaxFlashUsd ?? 50_000;
    const flashAmountUsd = Math.min(tvlUsd * FLASH_AMOUNT_FRACTION, maxFlash);
    if (flashAmountUsd < 1000) return null;

    const [lo, hi] = t0addr < t1addr ? [t0addr, t1addr] : [t1addr, t0addr];
    const pairKey = `${lo}_${hi}`;

    return {
      poolAddress: poolAddr,
      poolId,
      dex,
      dexType,
      router: venue.router,
      quoter: venue.quoter,
      token0: t0,
      token1: t1,
      feeTier,
      tvlUsd,
      flashAmountUsd,
      pairKey,
      chainKey: chain.name.toLowerCase(),
    };
  } catch {
    return null;
  }
}

// Cache token metadata to avoid redundant on-chain calls (keyed by chainId:address)
const _tokenCache = new Map<string, TokenMeta>();

async function fetchTokenMeta(cacheKey: string, address: string, provider: any, ethers: any): Promise<TokenMeta | null> {
  if (_tokenCache.has(cacheKey)) return _tokenCache.get(cacheKey)!;
  try {
    const token = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    const meta: TokenMeta = { address, symbol: String(symbol), decimals: Number(decimals) };
    _tokenCache.set(cacheKey, meta);
    return meta;
  } catch {
    return null;
  }
}

// ============================================================================
// Balancer Pool Discovery — Balancer V3 API (api-v3.balancer.fi)
// ============================================================================

/**
 * Fetch Balancer V2 pools from the Balancer V3 API.
 * DeFiLlama `pool` field is a UUID (not an on-chain address), so we use Balancer's
 * own API which provides pool addresses, poolIds, tokens, and TVL directly.
 *
 * Multi-token pools generate pairwise CandidatePool entries for each token pair
 * (e.g. a WBTC-WETH-USDC pool → 3 entries: WBTC/WETH, WBTC/USDC, WETH/USDC).
 */
async function fetchBalancerPools(provider: any, ethers: any, chain: ChainConfig): Promise<CandidatePool[]> {
  try {
    const query = `{
      poolGetPools(
        where: { chainIn: [${chain.balancerApiChain}], minTvl: ${MIN_POOL_TVL_USD} }
        orderBy: totalLiquidity
        orderDirection: desc
        first: 20
      ) {
        id
        address
        name
        type
        dynamicData { totalLiquidity }
        poolTokens { address symbol decimals }
      }
    }`;

    const resp = await fetch('https://api-v3.balancer.fi/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) throw new Error(`Balancer API: ${resp.status}`);

    const data = await resp.json() as any;
    const apiPools = data.data?.poolGetPools;
    if (!apiPools?.length) return [];

    const env = getCFOEnv();
    const maxFlash = env.evmArbMaxFlashUsd ?? 50_000;
    const pools: CandidatePool[] = [];
    const cacheKeyPrefix = `${chain.chainId}:`;

    for (const p of apiPools) {
      if (!['WEIGHTED', 'STABLE', 'COMPOSABLE_STABLE'].includes(p.type)) continue;

      const tvlUsd = parseFloat(p.dynamicData?.totalLiquidity ?? '0');
      if (tvlUsd < MIN_POOL_TVL_USD) continue;

      const poolAddr = p.address.toLowerCase();
      const poolId = p.id as string;

      const tokens = (p.poolTokens ?? []).filter(
        (t: any) => t.address.toLowerCase() !== poolAddr
      );
      if (tokens.length < 2) continue;

      const tokenMetas = await Promise.all(
        tokens.map((t: any) => {
          const addr = t.address.toLowerCase();
          return fetchTokenMeta(cacheKeyPrefix + addr, addr, provider, ethers);
        })
      );

      for (let i = 0; i < tokenMetas.length; i++) {
        for (let j = i + 1; j < tokenMetas.length; j++) {
          const t0 = tokenMetas[i];
          const t1 = tokenMetas[j];
          if (!t0 || !t1) continue;

          const flashAmountUsd = Math.min(tvlUsd * FLASH_AMOUNT_FRACTION, maxFlash);
          if (flashAmountUsd < 1000) continue;

          const [lo, hi] = t0.address < t1.address
            ? [t0.address, t1.address]
            : [t1.address, t0.address];

          pools.push({
            poolAddress: poolAddr,
            poolId,
            dex: 'balancer',
            dexType: DEX_BALANCER,
            router: chain.balancerVault,
            quoter: chain.balancerVault,
            token0: t0,
            token1: t1,
            feeTier: 0,
            tvlUsd,
            flashAmountUsd,
            pairKey: `${lo}_${hi}`,
            chainKey: chain.name.toLowerCase(),
          });
        }
      }
    }

    logger.info(`[ArbMonitor] ${chain.name} Balancer: ${apiPools.length} pools → ${pools.length} pairwise entries`);
    return pools;
  } catch (err) {
    logger.warn(`[ArbMonitor] ${chain.name} Balancer API fetch failed:`, err);
    return [];
  }
}

// ============================================================================
// On-chain Quoting (staticCall — free, no gas)
// ============================================================================

/**
 * Quote Uniswap v3: quoteExactInputSingle with fee tier in the request.
 * Uses staticCall — simulates without broadcasting.
 */
async function quoteUniswapV3(
  quoterAddr: string, tokenIn: string, tokenOut: string,
  amountIn: bigint, feeTier: number, ethers: any, provider: any,
): Promise<bigint | null> {
  try {
    const quoter = new ethers.Contract(quoterAddr, UNI_QUOTER_ABI, provider);
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn, fee: feeTier, sqrtPriceLimitX96: 0,
    });
    return result.amountOut as bigint;
  } catch (err) {
    logger.debug(`[ArbMonitor] Uniswap quote failed ${tokenIn.slice(0,6)}→${tokenOut.slice(0,6)}: ${(err as Error).message?.slice(0, 80)}`);
    return null;
  }
}

// Algebra pool ABI for local pool-level quoting (Camelot V3)
const ALGEBRA_POOL_ABI = [
  'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint16 communityFeeToken0, uint16 communityFeeToken1, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
];

/**
 * Quote Camelot v3 (Algebra): local concentrated-liquidity math.
 *
 * Reads pool's globalState() + liquidity() on-chain and computes output locally.
 * This avoids needing a deployed Algebra QuoterV2 contract (which is unresolved
 * on Arbitrum — the address 0x0524... belongs to SushiSwap, not Camelot).
 *
 * Math is identical to Uniswap V3 single-tick formula:
 *   zeroToOne: sqrtPNew = sqrtP * L / (L * Q96 + amountInAfterFee * sqrtP)
 *              amountOut = L * (sqrtP - sqrtPNew) / Q96
 *   oneToZero: sqrtPNew = sqrtP + amountInAfterFee * Q96 / L
 *              amountOut = L * (sqrtPNew - sqrtP) * Q96 / (sqrtPNew * sqrtP)
 *
 * Accurate for amounts that don't cross initialized ticks (our flash = 5% of TVL).
 */
async function quoteCamelotV3(
  poolAddress: string, tokenIn: string, tokenOut: string,
  amountIn: bigint, ethers: any, provider: any,
): Promise<bigint | null> {
  try {
    const pool = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, provider);
    const [gs, liq, t0] = await Promise.all([
      pool.globalState(), pool.liquidity(), pool.token0(),
    ]);

    const sqrtP: bigint = gs.price;
    const L: bigint = liq;
    const fee: bigint = BigInt(gs.fee); // Algebra fee in 1e-6 units (e.g. 100 = 0.01%)
    if (L === 0n || sqrtP === 0n) return null;

    const Q96 = 1n << 96n;
    const amountInAfterFee = amountIn * (1_000_000n - fee) / 1_000_000n;
    const zeroToOne = tokenIn.toLowerCase() === t0.toLowerCase();

    let amountOut: bigint;
    if (zeroToOne) {
      // Selling token0, buying token1
      const num = sqrtP * L;
      const den = L * Q96 + amountInAfterFee * sqrtP;
      const sqrtPNew = num * Q96 / den;
      amountOut = L * (sqrtP - sqrtPNew) / Q96;
    } else {
      // Selling token1, buying token0
      const sqrtPNew = sqrtP + amountInAfterFee * Q96 / L;
      amountOut = L * Q96 * (sqrtPNew - sqrtP) / (sqrtPNew * sqrtP);
    }

    return amountOut > 0n ? amountOut : null;
  } catch (err) {
    logger.debug(`[ArbMonitor] Camelot quote failed ${tokenIn.slice(0,6)}→${tokenOut.slice(0,6)}: ${(err as Error).message?.slice(0, 80)}`);
    return null;
  }
}

/**
 * Quote Balancer: queryBatchSwap with GIVEN_IN (kind=0).
 * Returns negative int256 for output token (Balancer's sign convention).
 */
async function quoteBalancer(
  poolId: string, tokenIn: string, tokenOut: string,
  amountIn: bigint, ethers: any, provider: any,
): Promise<bigint | null> {
  try {
    const vault = new ethers.Contract(BALANCER_VAULT_CANONICAL, BALANCER_VAULT_ABI, provider);
    const assets = [tokenIn, tokenOut];
    const swaps = [{ poolId, assetInIndex: 0, assetOutIndex: 1, amount: amountIn, userData: '0x' }];
    const funds = {
      sender: ethers.ZeroAddress, fromInternalBalance: false,
      recipient: ethers.ZeroAddress, toInternalBalance: false,
    };
    const deltas: bigint[] = await vault.queryBatchSwap(0, swaps, assets, funds);
    // deltas[1] is negative = vault pays out tokenOut
    const out = deltas[1] < 0n ? -deltas[1] : 0n;
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

/**
 * Get a quote for tokenIn → tokenOut on a given pool.
 * Dispatches to the correct quoter based on pool.dex.
 */
async function getPoolQuote(
  pool: CandidatePool, tokenIn: string, tokenOut: string,
  amountIn: bigint, ethers: any, provider: any,
): Promise<bigint | null> {
  if (pool.dex === 'uniswap_v3' || pool.dex === 'pancake_v3' || pool.dex === 'sushi_v3' || pool.dex === 'ramses_v2') {
    // All use Uniswap V3 QuoterV2 ABI (forks with same interface)
    return quoteUniswapV3(pool.quoter, tokenIn, tokenOut, amountIn, pool.feeTier, ethers, provider);
  } else if (pool.dex === 'camelot_v3') {
    // Local pool-level math — reads globalState + liquidity from pool contract directly
    return quoteCamelotV3(pool.poolAddress, tokenIn, tokenOut, amountIn, ethers, provider);
  } else {
    return quoteBalancer(pool.poolId, tokenIn, tokenOut, amountIn, ethers, provider);
  }
}

// ============================================================================
// Opportunity Scanner
// ============================================================================

/**
 * Find the best arb opportunity across all enabled chains.
 *
 * Groups pools by chain, then by pair within each chain (can't arb across chains).
 * For each cross-venue pair: quote buy and sell legs, calculate net profit.
 *
 * @param ethPriceUsd   ETH price for gas cost conversion (from Analyst intel)
 */
export async function scanForOpportunity(ethPriceUsd: number): Promise<ArbOpportunity | null> {
  const env = getCFOEnv();
  if (!env.evmArbEnabled) return null;

  const allPools = await refreshCandidatePools();
  if (allPools.length === 0) return null;

  // Per-chain minProfit from config; env var overrides only if explicitly set
  const envMinProfitOverride = process.env.CFO_EVM_ARB_MIN_PROFIT_USDC;
  const enabledChains = getEnabledChains();

  let best: ArbOpportunity | null = null;

  // Scan each chain independently (can't arb across chains)
  for (const chain of enabledChains) {
    const chainPools = allPools.filter(p => p.chainKey === chain.name.toLowerCase());
    if (chainPools.length === 0) continue;

    // Use per-chain minProfit from config; env var overrides if explicitly set
    const minProfit = envMinProfitOverride != null ? Number(envMinProfitOverride) : chain.minProfitUsd;
    const chainBest = await scanChain(chain, chainPools, ethPriceUsd, minProfit);
    if (chainBest && (!best || chainBest.netProfitUsd > best.netProfitUsd)) {
      best = chainBest;
    }
  }

  return best;
}

/**
 * Scan a single chain for arb opportunities.
 */
async function scanChain(
  chain: ChainConfig, pools: CandidatePool[],
  ethPriceUsd: number, minProfit: number,
): Promise<ArbOpportunity | null> {
  const { provider, ethers } = await loadChain(chain.chainId);

  // ── Group pools by pair ─────────────────────────────────────────────────
  const byPair = new Map<string, CandidatePool[]>();
  for (const pool of pools) {
    const arr = byPair.get(pool.pairKey) ?? [];
    arr.push(pool);
    byPair.set(pool.pairKey, arr);
  }

  const crossVenuePairs = [...byPair.entries()].filter(([, p]) => p.length >= 2);
  logger.info(
    `[ArbMonitor] ${chain.name}: ${byPair.size} pairs, ${crossVenuePairs.length} cross-venue. ` +
    `Top: ${
      crossVenuePairs.slice(0, 3).map(([, p]) =>
        `${p[0].token0.symbol}/${p[0].token1.symbol}(${p.map(pp => pp.dex).join('+')})`
      ).join(', ') || 'none'
    }`
  );

  if (crossVenuePairs.length === 0) return null;

  let best: ArbOpportunity | null = null;

  // ── Fetch live gas price ──────────────────────────────────────────────
  let gasPriceGwei = 0.01; // fallback for L2s
  try {
    const feeData = await provider.getFeeData();
    if (feeData.gasPrice) gasPriceGwei = Number(feeData.gasPrice) / 1e9;
  } catch { /* use fallback */ }

  // Diagnostic counters
  let pairsSingleVenue = 0, pairsNoFlashAsset = 0, pairsQuoteFail = 0;
  let pairsNoGross = 0, pairsBelowMin = 0, pairsQuoted = 0;

  const AAVE_LISTED = chain.aaveListedTokens;

  for (const [pairKey, pairPools] of byPair) {
    if (pairPools.length < 2) { pairsSingleVenue++; continue; }

    const pool0 = pairPools[0];
    const t0 = pool0.token0.address;
    const t1 = pool0.token1.address;

    const flashAsset = AAVE_LISTED.has(t0) ? pool0.token0
      : AAVE_LISTED.has(t1) ? pool0.token1
      : null;
    if (!flashAsset) { pairsNoFlashAsset++; continue; }

    const tokenOut = flashAsset.address === t0 ? pool0.token1 : pool0.token0;

    // Flash amount: smallest pool's computed size (conservative)
    const flashAmountUsd = Math.min(...pairPools.map(p => p.flashAmountUsd));
    const flashAmountRaw = BigInt(
      Math.floor(flashAmountUsd * 10 ** flashAsset.decimals)
    );

    try {
      // ── Quote buy leg: flashAsset → tokenOut on each venue ───────────────
      const buyQuotes: Array<{ pool: CandidatePool; amountOut: bigint }> = [];
      await Promise.all(pairPools.map(async pool => {
        const out = await getPoolQuote(pool, flashAsset.address, tokenOut.address, flashAmountRaw, ethers, provider);
        if (out && out > 0n) buyQuotes.push({ pool, amountOut: out });
      }));
      if (buyQuotes.length === 0) { pairsQuoteFail++; continue; }

      // Best buy = most tokenOut for our flashAsset
      buyQuotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
      const buyBest = buyQuotes[0];

      // ── Quote sell leg: tokenOut → flashAsset, on remaining venues ────────
      // Use the OTHER pools (not the buy pool) for sell leg
      const sellCandidates = pairPools.filter(p => p.poolAddress !== buyBest.pool.poolAddress);
      const sellQuotes: Array<{ pool: CandidatePool; amountOut: bigint }> = [];

      await Promise.all(sellCandidates.map(async pool => {
        const out = await getPoolQuote(pool, tokenOut.address, flashAsset.address, buyBest.amountOut, ethers, provider);
        if (out && out > 0n) sellQuotes.push({ pool, amountOut: out });
      }));
      if (sellQuotes.length === 0) { pairsQuoteFail++; continue; }

      sellQuotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
      const sellBest = sellQuotes[0];

      // ── Profit calculation ─────────────────────────────────────────────────
      pairsQuoted++;

      const displayPair = `${flashAsset.symbol}/${tokenOut.symbol}`;

      if (sellBest.amountOut <= flashAmountRaw) {
        // Negative spread — sell gets less than flash amount (market is well-arbed or we're price-impacting)
        const lossRaw = flashAmountRaw - sellBest.amountOut;
        const lossUsd = Number(lossRaw) / (10 ** flashAsset.decimals);
        const lossBps = flashAmountUsd > 0 ? (lossUsd / flashAmountUsd * 10_000).toFixed(1) : '0';
        pairsNoGross++;
        // Log the top negative spreads so we can see how tight the market is
        if (lossUsd < flashAmountUsd * 0.01) { // within 1% — worth reporting
          logger.info(
            `[ArbMonitor] ↔ ${displayPair} | ${buyBest.pool.dex}→${sellBest.pool.dex} | ` +
            `flash:$${flashAmountUsd.toFixed(0)} spread:-${lossBps}bps ` +
            `(buy ${buyQuotes.length} venues, sell ${sellQuotes.length} venues)`
          );
        }
        continue;
      }

      const grossRaw = sellBest.amountOut - flashAmountRaw;
      const grossUsd = Number(grossRaw) / (10 ** flashAsset.decimals);
      const aaveFeeUsd = flashAmountUsd * (AAVE_FLASH_FEE_BPS / 10_000);
      const gasEstimateUsd = (chain.gasUnits2Swap * gasPriceGwei * 1e-9) * ethPriceUsd;
      const netProfitUsd = grossUsd - aaveFeeUsd - gasEstimateUsd;

      const spreadBps = flashAmountUsd > 0 ? (grossUsd / flashAmountUsd * 10_000).toFixed(1) : '0';

      if (netProfitUsd < minProfit) {
        pairsBelowMin++;
        logger.info(
          `[ArbMonitor] ❌ ${displayPair} | ${buyBest.pool.dex}→${sellBest.pool.dex} | ` +
          `flash:$${flashAmountUsd.toFixed(0)} spread:${spreadBps}bps ` +
          `gross:$${grossUsd.toFixed(3)} net:$${netProfitUsd.toFixed(3)} (need $${minProfit.toFixed(2)})`
        );
        continue;
      }

      logger.info(
        `[ArbMonitor] 💡 ${displayPair} | ${buyBest.pool.dex}→${sellBest.pool.dex} | ` +
        `flash:$${flashAmountUsd.toFixed(0)} spread:${spreadBps}bps ` +
        `gross:$${grossUsd.toFixed(3)} aave:$${aaveFeeUsd.toFixed(3)} ` +
        `gas:$${gasEstimateUsd.toFixed(3)} net:$${netProfitUsd.toFixed(3)}`
      );

      const opp: ArbOpportunity = {
        pairKey,
        displayPair,
        flashLoanAsset: flashAsset.address,
        flashLoanSymbol: flashAsset.symbol,
        flashAmountRaw,
        flashAmountUsd,
        buyPool: buyBest.pool,
        sellPool: sellBest.pool,
        tokenOut,
        expectedGrossUsd: grossUsd,
        aaveFeeUsd,
        gasEstimateUsd,
        netProfitUsd,
        chainKey: chain.name.toLowerCase(),
        detectedAt: Date.now(),
      };

      if (!best || opp.netProfitUsd > best.netProfitUsd) best = opp;

    } catch (err) {
      pairsQuoteFail++;
      logger.debug(`[ArbMonitor] ${chain.name} pair ${pairKey} scan error:`, err);
    }
  }

  logger.info(
    `[ArbMonitor] ${chain.name} scan: ${crossVenuePairs.length} pairs → ` +
    `quoted:${pairsQuoted} noGross:${pairsNoGross} belowMin:${pairsBelowMin} ` +
    `quoteFail:${pairsQuoteFail} noFlash:${pairsNoFlashAsset} | ` +
    `gas:${gasPriceGwei.toFixed(3)}gwei minProfit:$${minProfit.toFixed(2)}`
  );

  // ── Triangular arb: A → B → C → A across different pools ──────────────
  const BRIDGE_TOKENS = chain.bridgeTokens;

  // Build adjacency: token → [pools that contain this token]
  const tokenPools = new Map<string, CandidatePool[]>();
  for (const pool of pools) {
    const t0 = pool.token0.address;
    const t1 = pool.token1.address;
    (tokenPools.get(t0) ?? (() => { const a: CandidatePool[] = []; tokenPools.set(t0, a); return a; })()).push(pool);
    (tokenPools.get(t1) ?? (() => { const a: CandidatePool[] = []; tokenPools.set(t1, a); return a; })()).push(pool);
  }

  let triScanned = 0;
  for (const bridgeToken of BRIDGE_TOKENS) {
    const bridgePools = tokenPools.get(bridgeToken) ?? [];
    if (bridgePools.length < 2) continue;

    // Get all tokens reachable via the bridge token
    const reachable = new Map<string, CandidatePool[]>(); // other_token → pools
    for (const pool of bridgePools) {
      const other = pool.token0.address === bridgeToken ? pool.token1.address : pool.token0.address;
      (reachable.get(other) ?? (() => { const a: CandidatePool[] = []; reachable.set(other, a); return a; })()).push(pool);
    }

    const reachableTokens = [...reachable.keys()];
    // For each pair (A, C) reachable via bridge B, check: A→B→C→A
    for (let i = 0; i < reachableTokens.length && triScanned < 50; i++) {
      const tokenA = reachableTokens[i];
      if (!AAVE_LISTED.has(tokenA)) continue; // must be able to flash A

      for (let j = i + 1; j < reachableTokens.length && triScanned < 50; j++) {
        const tokenC = reachableTokens[j];

        // Check if direct A/C pool exists (for the final leg C→A)
        const acKey1 = tokenA < tokenC ? `${tokenA}_${tokenC}` : `${tokenC}_${tokenA}`;
        const acPools = byPair.get(acKey1);
        if (!acPools || acPools.length === 0) continue;

        triScanned++;

        // Find best pool for each leg
        const abPools = reachable.get(tokenA) ?? [];
        const bcPools = reachable.get(tokenC) ?? [];

        // Flash token A, route: A → B (via abPool) → C (via bcPool) → A (via acPool)
        const tokenAMeta = abPools[0].token0.address === tokenA ? abPools[0].token0 : abPools[0].token1;
        const flashAmtUsd = Math.min(
          ...abPools.map(p => p.flashAmountUsd),
          ...bcPools.map(p => p.flashAmountUsd),
          ...acPools.map(p => p.flashAmountUsd),
        );
        if (flashAmtUsd < 1000) continue;

        const flashAmtRaw = BigInt(Math.floor(flashAmtUsd * 10 ** tokenAMeta.decimals));

        try {
          // Leg 1: A → B (pick best abPool)
          let bestLeg1Out = 0n;
          let bestLeg1Pool: CandidatePool | null = null;
          for (const pool of abPools) {
            const out = await getPoolQuote(pool, tokenA, bridgeToken, flashAmtRaw, ethers, provider);
            if (out && out > bestLeg1Out) { bestLeg1Out = out; bestLeg1Pool = pool; }
          }
          if (!bestLeg1Pool || bestLeg1Out === 0n) continue;

          // Leg 2: B → C (pick best bcPool)
          let bestLeg2Out = 0n;
          let bestLeg2Pool: CandidatePool | null = null;
          for (const pool of bcPools) {
            const out = await getPoolQuote(pool, bridgeToken, tokenC, bestLeg1Out, ethers, provider);
            if (out && out > bestLeg2Out) { bestLeg2Out = out; bestLeg2Pool = pool; }
          }
          if (!bestLeg2Pool || bestLeg2Out === 0n) continue;

          // Leg 3: C → A (pick best acPool)
          let bestLeg3Out = 0n;
          let bestLeg3Pool: CandidatePool | null = null;
          for (const pool of acPools) {
            const out = await getPoolQuote(pool, tokenC, tokenA, bestLeg2Out, ethers, provider);
            if (out && out > bestLeg3Out) { bestLeg3Out = out; bestLeg3Pool = pool; }
          }
          if (!bestLeg3Pool || bestLeg3Out === 0n) continue;

          // Profit: leg3 output - flash input
          if (bestLeg3Out <= flashAmtRaw) continue;
          const triGrossRaw = bestLeg3Out - flashAmtRaw;
          const triGrossUsd = Number(triGrossRaw) / (10 ** tokenAMeta.decimals);
          const triAaveFee = flashAmtUsd * (AAVE_FLASH_FEE_BPS / 10_000);
          const triGasCost = (chain.gasUnits3Swap * gasPriceGwei * 1e-9) * ethPriceUsd;
          const triNetProfit = triGrossUsd - triAaveFee - triGasCost;

          const bridgeMeta = bestLeg1Pool.token0.address === bridgeToken ? bestLeg1Pool.token0 : bestLeg1Pool.token1;
          const tokenCMeta = bestLeg2Pool.token0.address === tokenC ? bestLeg2Pool.token0 : bestLeg2Pool.token1;
          const triDisplay = `${tokenAMeta.symbol}→${bridgeMeta.symbol}→${tokenCMeta.symbol}→${tokenAMeta.symbol}`;
          const triSpreadBps = flashAmtUsd > 0 ? (triGrossUsd / flashAmtUsd * 10_000).toFixed(1) : '0';

          if (triNetProfit < minProfit) {
            if (triNetProfit > -1) {
              logger.debug(
                `[ArbMonitor] ❌ TRI ${triDisplay} | ` +
                `flash:$${flashAmtUsd.toFixed(0)} spread:${triSpreadBps}bps net:$${triNetProfit.toFixed(3)} (need $${minProfit.toFixed(2)})`
              );
            }
            continue;
          }

          logger.info(
            `[ArbMonitor] 💡 TRI ${triDisplay} | ` +
            `${bestLeg1Pool.dex}→${bestLeg2Pool.dex}→${bestLeg3Pool.dex} | ` +
            `flash:$${flashAmtUsd.toFixed(0)} spread:${triSpreadBps}bps net:$${triNetProfit.toFixed(3)}`
          );

          // Wrap as opportunity (use leg1 as "buy" and leg3 as "sell" for compatibility)
          const triOpp: ArbOpportunity = {
            pairKey: `tri:${tokenA}:${bridgeToken}:${tokenC}`,
            displayPair: triDisplay,
            flashLoanAsset: tokenA,
            flashLoanSymbol: tokenAMeta.symbol,
            flashAmountRaw: flashAmtRaw,
            flashAmountUsd: flashAmtUsd,
            buyPool: bestLeg1Pool,
            sellPool: bestLeg3Pool,
            tokenOut: tokenCMeta,
            expectedGrossUsd: triGrossUsd,
            aaveFeeUsd: triAaveFee,
            gasEstimateUsd: triGasCost,
            netProfitUsd: triNetProfit,
            chainKey: chain.name.toLowerCase(),
            detectedAt: Date.now(),
          };

          if (!best || triOpp.netProfitUsd > best.netProfitUsd) best = triOpp;
        } catch {
          // Non-fatal — skip this tri route
        }
      }
    }

    if (triScanned > 0) {
      logger.debug(`[ArbMonitor] Triangular routes scanned: ${triScanned}`);
    }
  }

  return best;
}

// ============================================================================
// Flash Loan Executor
// ============================================================================

export async function executeFlashArb(opp: ArbOpportunity, ethPriceUsd = 3000): Promise<ArbResult> {
  const env = getCFOEnv();

  if (env.dryRun) {
    logger.info(
      `[ArbMonitor] DRY RUN — ${opp.displayPair} | ` +
      `${opp.buyPool.dex}→${opp.sellPool.dex} | net:$${opp.netProfitUsd.toFixed(3)}`
    );
    return { success: true, profitUsd: opp.netProfitUsd, txHash: `dry-arb-${Date.now()}` };
  }

  // ── Staleness guard: quotes drift fast, reject opportunities older than 30s ──
  const ageMs = Date.now() - opp.detectedAt;
  if (ageMs > 30_000) {
    logger.warn(`[ArbMonitor] Stale opportunity — detected ${(ageMs / 1000).toFixed(0)}s ago, skipping`);
    return { success: false, error: `Opportunity stale (${(ageMs / 1000).toFixed(0)}s old)` };
  }

  // Resolve receiver address for the opportunity's chain (DB → env → error)
  const receiverAddr = await getReceiverAddress(opp.chainKey);
  if (!receiverAddr) {
    return { success: false, error: `No ArbFlashReceiver deployed on ${opp.chainKey}` };
  }

  // Load provider for the right chain
  const chainConfig = CHAIN_CONFIGS[opp.chainKey];
  if (!chainConfig) {
    return { success: false, error: `Unknown chain: ${opp.chainKey}` };
  }
  const { wallet, ethers } = await loadChain(chainConfig.chainId);

  // minProfit = 80% of expected (allows small quote drift between scan and execution)
  const minProfitRaw = BigInt(Math.floor(opp.netProfitUsd * 0.8 * 10 ** 6));

  const dexTypeFor = (pool: CandidatePool): number =>
    pool.dex === 'uniswap_v3' ? DEX_UNISWAP_V3
    : pool.dex === 'pancake_v3' ? DEX_UNISWAP_V3  // PCS V3 fork — same swap ABI as Uni V3
    : pool.dex === 'camelot_v3' ? DEX_CAMELOT_V3
    : DEX_BALANCER;

  // Encode params for ArbFlashReceiver.executeOperation()
  const params = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address','uint8','bytes32','uint24','address','uint8','bytes32','uint24','address','uint256'],
    [
      opp.buyPool.router,
      dexTypeFor(opp.buyPool),
      opp.buyPool.poolId,
      opp.buyPool.feeTier,
      opp.sellPool.router,
      dexTypeFor(opp.sellPool),
      opp.sellPool.poolId,
      opp.sellPool.feeTier,
      opp.tokenOut.address,
      minProfitRaw,
    ]
  );

  const receiver = new ethers.Contract(receiverAddr, RECEIVER_ABI, wallet);

  logger.info(
    `[ArbMonitor] 🚀 ${opp.chainKey.toUpperCase()} ${opp.displayPair} | ${opp.buyPool.dex}→${opp.sellPool.dex} | ` +
    `flash:$${opp.flashAmountUsd.toLocaleString()} | est net:$${opp.netProfitUsd.toFixed(3)}`
  );

  try {
    const tx      = await receiver.requestFlashLoan(opp.flashLoanAsset, opp.flashAmountRaw, params, { gasLimit: 1_400_000 });
    const receipt = await tx.wait(1);

    if (receipt.status === 0) {
      return { success: false, txHash: tx.hash, error: 'Reverted — spread closed before execution' };
    }

    // Estimate actual gas cost
    const gasUsedEth = Number(receipt.gasUsed) * Number(receipt.gasPrice ?? 0) / 1e18;
    const actualGasCostUsd = gasUsedEth * ethPriceUsd;
    const estimatedActualProfit = opp.expectedGrossUsd - opp.aaveFeeUsd - actualGasCostUsd;

    logger.info(
      `[ArbMonitor] ✅ Confirmed | ${opp.displayPair} | tx:${tx.hash} | ` +
      `gas:${Number(receipt.gasUsed).toLocaleString()} | est profit:$${estimatedActualProfit.toFixed(3)}`
    );

    return { success: true, txHash: tx.hash, profitUsd: estimatedActualProfit };

  } catch (err: any) {
    logger.error(`[ArbMonitor] Execution failed: ${err?.message ?? err}`);
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ============================================================================
// Status helpers
// ============================================================================

export async function getArbUsdcBalance(): Promise<number> {
  try {
    const { wallet, ethers, provider } = await loadArb();
    const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const usdc = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
    return Number(await usdc.balanceOf(wallet.address)) / 1e6;
  } catch { return 0; }
}

export function getCandidatePoolCount(): number { return _candidatePools.length; }
export function getPoolsRefreshedAt(): number    { return _poolsRefreshedAt; }
export function getEnabledChainNames(): string[] { return getEnabledChains().map(c => c.name); }

// ============================================================================
// Auto-deploy ArbFlashReceiver per chain
// ============================================================================

/** In-memory cache of deployed receiver addresses per chain */
const _receiverAddresses = new Map<string, string>();
let _receiversHydrated = false;

/**
 * Get receiver address for a chain. Resolution order:
 * 1. In-memory cache (populated from DB or auto-deploy)
 * 2. Env var (CFO_EVM_ARB_RECEIVER_ADDRESS / _BASE / _POLYGON / _OPTIMISM)
 * 3. DB lookup (cfo_arb_receivers table)
 * 4. Auto-deploy (compiles from pre-built bytecode, stores in DB)
 */
export async function getReceiverAddress(chainKey: string): Promise<string | undefined> {
  // 1. In-memory
  if (_receiverAddresses.has(chainKey)) return _receiverAddresses.get(chainKey);

  // 2. Env var
  const env = getCFOEnv();
  const envMap: Record<string, string | undefined> = {
    arbitrum: env.evmArbReceiverAddress,
    base: env.evmArbReceiverBase,
    polygon: env.evmArbReceiverPolygon,
    optimism: env.evmArbReceiverOptimism,
  };
  if (envMap[chainKey]) {
    _receiverAddresses.set(chainKey, envMap[chainKey]!);
    return envMap[chainKey];
  }

  return undefined;
}

/**
 * Hydrate receiver addresses from DB on startup.
 * Creates the table if it doesn't exist.
 */
export async function hydrateReceiversFromDb(pool: any): Promise<void> {
  if (_receiversHydrated || !pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cfo_arb_receivers (
        chain_key TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        deployed_at TIMESTAMPTZ DEFAULT NOW(),
        tx_hash TEXT
      )
    `);

    const res = await pool.query('SELECT chain_key, address FROM cfo_arb_receivers');
    for (const row of res.rows) {
      _receiverAddresses.set(row.chain_key, row.address);
      logger.info(`[ArbMonitor] Loaded receiver for ${row.chain_key}: ${row.address}`);
    }
    _receiversHydrated = true;
  } catch (err) {
    logger.warn('[ArbMonitor] Failed to hydrate receivers from DB:', err);
  }
}

/**
 * Auto-deploy ArbFlashReceiver to a chain.
 * Uses embedded bytecode (compiled from contracts/ArbFlashReceiver.sol).
 * Stores deployed address in DB and in-memory cache.
 */
export async function autoDeployReceiver(chainKey: string, dbPool?: any): Promise<string | null> {
  const chain = CHAIN_CONFIGS[chainKey];
  if (!chain) {
    logger.warn(`[ArbMonitor] Unknown chain for auto-deploy: ${chainKey}`);
    return null;
  }

  const aaveProvider = AAVE_ADDRESSES_PROVIDER[chainKey];
  if (!aaveProvider) {
    logger.warn(`[ArbMonitor] No Aave PoolAddressesProvider for ${chainKey}`);
    return null;
  }

  try {
    const { wallet, ethers, provider } = await loadChain(chain.chainId);

    // Check native token balance for deployment gas
    // L2s (Base, Optimism) need only ~0.0005 ETH; Polygon needs ~0.35 POL
    const balance = await provider.getBalance(wallet.address);
    const balanceEth = Number(balance) / 1e18;
    logger.info(`[ArbMonitor] ${chain.name} wallet balance: ${balanceEth.toFixed(6)} native`);
    if (balanceEth < 0.0005) {
      logger.warn(`[ArbMonitor] ${chain.name}: insufficient gas for deploy (${balanceEth.toFixed(6)} native). Fund wallet ${wallet.address}`);
      return null;
    }

    // Pre-flight: verify Aave PoolAddressesProvider is reachable and getPool() works
    const providerABI = ['function getPool() external view returns (address)'];
    const aaveProviderContract = new ethers.Contract(aaveProvider, providerABI, provider);
    let resolvedPoolAddr: string;
    try {
      resolvedPoolAddr = await aaveProviderContract.getPool();
      logger.info(`[ArbMonitor] ${chain.name} Aave pre-flight OK — Pool: ${resolvedPoolAddr}`);
    } catch (preErr: any) {
      logger.error(`[ArbMonitor] ${chain.name} Aave pre-flight FAILED — getPool() reverted on ${aaveProvider}. Wrong PoolAddressesProvider address?`, preErr?.message || preErr);
      return null;
    }
    if (!resolvedPoolAddr || resolvedPoolAddr === ethers.ZeroAddress) {
      logger.warn(`[ArbMonitor] ${chain.name} Aave getPool() returned zero address — pool not initialized on this chain`);
      return null;
    }

    // Embedded ABI + bytecode (compiled with solc 0.8.20 --via-ir --optimize --optimize-runs 200)
    // Source: contracts/ArbFlashReceiver.sol
    const abi = ARBFLASH_ABI;
    const bytecode = ARBFLASH_BYTECODE;

    if (!bytecode || bytecode === '0x') {
      logger.warn('[ArbMonitor] Empty bytecode — cannot deploy');
      return null;
    }

    logger.info(`[ArbMonitor] 🚀 Auto-deploying ArbFlashReceiver to ${chain.name} (chainId=${chain.chainId})...`);

    // Deploy with explicit gas limit (ethers' auto-estimation reverts on some L2 RPCs)
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);

    // Build deploy tx manually to verify encoding before sending
    const deployTx = await factory.getDeployTransaction(aaveProvider);
    const deployData = deployTx.data as string;
    logger.info(`[ArbMonitor] ${chain.name} deploy tx data: ${deployData.length} chars, starts=${deployData.slice(0, 20)}... ends=...${deployData.slice(-72)}`);
    // Last 64 hex chars should be the ABI-encoded constructor arg (padded address)
    logger.info(`[ArbMonitor] ${chain.name} constructor arg (last 64 hex): ${deployData.slice(-64)}`);

    // Note: eth_call simulation of CREATE txs is unreliable on some L2 RPC nodes
    // (returns spurious reverts on Base, Polygon, Optimism). The pre-flight getPool()
    // check above already verifies the only external call in the constructor, so we
    // skip simulation and deploy directly.

    // Send transaction with generous gas limit
    const tx = await wallet.sendTransaction({
      data: deployData,
      gasLimit: 2_500_000n,
    });
    logger.info(`[ArbMonitor] ${chain.name} deploy tx: ${tx.hash}`);

    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      logger.error(`[ArbMonitor] ${chain.name} deploy tx reverted on-chain. gasUsed=${receipt?.gasUsed}, status=${receipt?.status}`);
      // Check if contract was created despite revert (shouldn't happen but log it)
      if (receipt?.contractAddress) {
        const code = await provider.getCode(receipt.contractAddress);
        logger.error(`[ArbMonitor] ${chain.name} contract at ${receipt.contractAddress} has code: ${code.length > 2 ? 'YES' : 'NO'} (${code.length} chars)`);
      }
      return null;
    }
    const address = receipt.contractAddress?.toLowerCase();
    if (!address) {
      logger.error(`[ArbMonitor] ${chain.name} deploy tx succeeded but no contract address in receipt`);
      return null;
    }

    // Verify
    const deployed = new ethers.Contract(address, abi, provider);
    const owner = await deployed.owner();
    const resolvedPool = await deployed.aavePool();

    logger.info(`[ArbMonitor] ✅ ${chain.name} ArbFlashReceiver deployed at ${address}`);
    logger.info(`[ArbMonitor]    Owner: ${owner} | Aave Pool: ${resolvedPool}`);

    // Cache in memory
    _receiverAddresses.set(chainKey, address);

    // Persist to DB
    if (dbPool) {
      try {
        await dbPool.query(
          `INSERT INTO cfo_arb_receivers (chain_key, address, tx_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (chain_key) DO UPDATE SET address = $2, tx_hash = $3, deployed_at = NOW()`,
          [chainKey, address, tx.hash],
        );
        logger.info(`[ArbMonitor] Saved ${chain.name} receiver to DB`);
      } catch (dbErr) {
        logger.warn(`[ArbMonitor] Failed to save receiver to DB (address still cached in memory):`, dbErr);
      }
    }

    return address;

  } catch (err: any) {
    const code = err?.code || 'UNKNOWN';
    const reason = err?.reason || err?.shortMessage || 'no reason';
    logger.error(`[ArbMonitor] Auto-deploy to ${chain.name} failed [${code}]: ${reason}`);
    if (code === 'INSUFFICIENT_FUNDS') {
      logger.warn(`[ArbMonitor] ↳ Fund wallet on ${chain.name} (chainId=${chain.chainId}) with native gas token`);
    } else if (code === 'CALL_EXCEPTION') {
      logger.warn(`[ArbMonitor] ↳ Constructor reverted — verify Aave PoolAddressesProvider address for ${chain.name}: ${aaveProvider}`);
    }
    return null;
  }
}

/**
 * Ensure all enabled chains have a receiver deployed.
 * Called at startup and on each scan cycle — retries failed chains with backoff.
 */
let _receiversHydratedOnce = false;
const _deployFailures: Map<string, { count: number; nextRetryAt: number }> = new Map();
const MAX_DEPLOY_RETRIES = 5;
const DEPLOY_BACKOFF_BASE_MS = 60_000; // 1 min, doubles each retry

export async function ensureReceiversDeployed(dbPool?: any): Promise<void> {
  const firstRun = !_receiversHydratedOnce;
  if (firstRun && dbPool) {
    await hydrateReceiversFromDb(dbPool);
    _receiversHydratedOnce = true;
  }

  const enabled = getEnabledChains();
  for (const chain of enabled) {
    const key = chain.name.toLowerCase();
    const existing = await getReceiverAddress(key);
    if (existing) {
      if (firstRun) logger.info(`[ArbMonitor] ${chain.name} receiver: ${existing}`);
      continue;
    }

    // Check retry backoff
    const failure = _deployFailures.get(key);
    if (failure) {
      if (failure.count >= MAX_DEPLOY_RETRIES) continue; // permanently failed, don't log spam
      if (Date.now() < failure.nextRetryAt) continue;    // waiting for backoff
    }

    logger.info(`[ArbMonitor] No receiver for ${chain.name} — auto-deploying${failure ? ` (retry ${failure.count + 1}/${MAX_DEPLOY_RETRIES})` : ''}...`);
    const result = await autoDeployReceiver(key, dbPool);
    if (result) {
      _deployFailures.delete(key);
    } else {
      const prev = failure?.count ?? 0;
      const next = prev + 1;
      const backoffMs = DEPLOY_BACKOFF_BASE_MS * Math.pow(2, prev);
      _deployFailures.set(key, { count: next, nextRetryAt: Date.now() + backoffMs });
      if (next >= MAX_DEPLOY_RETRIES) {
        logger.error(`[ArbMonitor] ${chain.name} deploy failed ${MAX_DEPLOY_RETRIES} times — giving up. Set receiver address manually via CFO_EVM_ARB_RECEIVER_${chain.name.toUpperCase()}`);
      } else {
        logger.warn(`[ArbMonitor] ${chain.name} deploy failed — will retry in ${Math.round(backoffMs / 1000)}s`);
      }
    }
  }
}

// ── 24h profit tracker (in-memory, resets on restart) ──────────────────────
const _profitLog: Array<{ timestamp: number; profitUsd: number }> = [];
let _profitHydrated = false;

export function recordProfit(profitUsd: number): void {
  _profitLog.push({ timestamp: Date.now(), profitUsd });
  const cutoff = Date.now() - 48 * 3600_000;
  while (_profitLog.length > 0 && _profitLog[0].timestamp < cutoff) _profitLog.shift();
}

export function getProfit24h(): number {
  const cutoff = Date.now() - 24 * 3600_000;
  return _profitLog.filter(p => p.timestamp >= cutoff).reduce((s, p) => s + p.profitUsd, 0);
}

/**
 * One-shot hydration: load confirmed arb profits from the DB so in-memory
 * tracker survives process restarts. Call once at startup or first cycle.
 */
export async function hydrateProfit24hFromDb(pool: any): Promise<void> {
  if (_profitHydrated || !pool) return;
  try {
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    const res = await pool.query(
      `SELECT timestamp, metadata->>'netProfitUsd' AS profit
       FROM cfo_transactions
       WHERE strategy_tag = 'evm_flash_arb' AND status = 'confirmed'
         AND timestamp >= $1
       ORDER BY timestamp ASC`,
      [cutoff],
    );
    let count = 0;
    for (const row of res.rows) {
      const profitUsd = parseFloat(row.profit);
      if (!isNaN(profitUsd) && profitUsd > 0) {
        const ts = new Date(row.timestamp).getTime();
        // Avoid duplicates: only add if not already in the log
        if (!_profitLog.some(p => Math.abs(p.timestamp - ts) < 5000)) {
          _profitLog.push({ timestamp: ts, profitUsd });
          count++;
        }
      }
    }
    _profitHydrated = true;
    if (count > 0) logger.info(`[ArbMonitor] Hydrated ${count} arb profits from DB (24h total: $${getProfit24h().toFixed(2)})`);
  } catch (err) {
    logger.debug('[ArbMonitor] DB profit hydration failed (non-fatal):', err);
  }
}

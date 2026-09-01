# LONG Tracker — Phase 1 Reconnaissance

Date: 2026-08-31
Scope: Robinhood Chain mainnet (`chainId = 4663`) and the current public LONG/LongX surfaces.
Status: Phase 1 complete; no application code has been created yet.

## Executive conclusion

The tracker should use LONG's launcher events on Robinhood Chain as its primary discovery source, then verify and enrich every launch through Airlock receipts and `getAssetData(address)`. LONG has used two launcher contracts, so a tracker that watches only the current one loses the earliest launches:

| Role | Address | Observed interval |
|---|---|---|
| Legacy LONG launcher | `0x9c88f06b72fcd3cedbef3be7521ee5abd72d0845` | First event at block `8,145,291` |
| Current LONG launcher | `0x22e99278308b393ea1260859b181ad7e78f5eeed` | First event at block `8,658,626` |
| Canonical Doppler Airlock | `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` | Shared infrastructure, not LONG-exclusive |
| Initializer actually used by observed LONG launches | `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544` | `DopplerHookInitializer` / dynamic auction |

Airlock and the initializer are shared Doppler contracts. Listening to their generic `Create` events without a LONG-specific discriminator would incorrectly include deployment tests and launches by other integrators. The launcher `LaunchCreated` event is the clean discriminator; Airlock and initializer logs are the canonical cross-check.

The current launch shape is a dynamic auction implemented through `DopplerHookInitializer` and Uniswap v4 hooks. It is not a static auction, opening auction, or the older Frames/multicurve presentation.

The public frontend has a real data API at `https://api.long.xyz/graphql`, but Cloudflare rejects ordinary command-line requests with HTTP 403. The browser-hosted GraphiQL works without an application auth header. This makes the GraphQL service useful for reconciliation and enrichment, but unsuitable as the only tracker dependency.

LongX assets are ERC-20 vault contracts deployed on Robinhood Chain. Supply issuance is the standard ERC-20 `Transfer` from the zero address; the protocol lifecycle also emits `RequestSettled`, followed later by `Claimed` when the vault-held shares are delivered to the receiver.

## 1. Chain identity and canonical deployment

Public RPC:

```text
https://rpc.mainnet.chain.robinhood.com
```

Probe:

```bash
curl --fail --silent --show-error \
  https://rpc.mainnet.chain.robinhood.com \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

Relevant response:

```json
{"jsonrpc":"2.0","id":1,"result":"0x1237"}
```

`0x1237` is decimal `4663`.

The current upstream Whetstone deployment registry now contains a Robinhood Mainnet entry. The relevant canonical addresses are:

| Contract | Address |
|---|---|
| Airlock | `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` |
| DopplerERC20V1Factory | `0x1b37d3a72082029c44b35b604ea473617580b69a` |
| DopplerHookInitializer | `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544` |
| DopplerHookMigrator | `0x7bf319d8e969f7596b1bc171da9ce322f67ae0c4` |
| LockableUniswapV3Initializer | `0xde8886a0019ea060b8378ee37b8a23b8117f29a3` |
| UniswapV4Initializer | `0x6cce158b6d1747617fc218592b4d60b239b957ea` |
| NoOpMigrator | `0xba2f330edb16cd8056f5988d8ce19bbc63475a0e` |

Source: [Whetstone Doppler deployment registry](https://github.com/whetstoneresearch/doppler/blob/main/Deployments.json), entry `4663`.

Only `DopplerHookInitializer` is present in the launch receipts sampled here, including the earliest known LONG launch and the current `$AI` launch. The other initializer addresses are canonical modules, but are not evidence that LONG currently uses those auction shapes.

## 2. LONG creation path

The on-chain receipt establishes this path:

```text
creator EOA
  -> LONG launcher create(tuple)            selector 0x882db707
  -> Doppler Airlock create(...)
  -> DopplerERC20V1Factory                  creates the ERC-20 asset
  -> DopplerHookInitializer                 initializes the dynamic auction
  -> Uniswap v4 PoolManager                 0x8366a39cc670b4001a1121b8f6a443a643e40951
```

The launcher function selector resolves to:

```text
create((uint256,uint256,address,address,bytes,address,bytes,address,bytes,address,bytes,address,bytes32))
```

The launcher has been upgraded/redeployed at least once. The two launcher addresses emit the same `LaunchCreated` signature and call the same Airlock and observed initializer.

### Exact event signatures

The LONG-specific discovery event is:

```solidity
event LaunchCreated(
    address indexed asset,
    address indexed poolOrHook,
    address indexed numeraire,
    address initializer,
    address creator,
    bytes32 salt,
    uint48 startTime,
    uint48 endTime,
    string symbol
);
```

The fifth address is confirmed as the launcher caller/creator: for `$AI` it is
`0x9b1513dfdfc023fa6e576b130066ec05b6f1bfa1`, while Airlock's `integrator` for that same
asset is `0x92d435c96e63c43e12d6d0ab28f6b0b04072f765`.

Topic 0:

```text
0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b
```

The initializer event requested in the briefing is:

```solidity
event Create(
    address indexed poolOrHook,
    address indexed asset,
    address indexed numeraire
);
```

Emitting address:

```text
0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544
```

Topic 0:

```text
0xb224da6575b2c2ffd42454faedb236f7dbe5f92a0c96bb99c0273dbe98464c7e
```

Airlock emits a different event with the same name:

```solidity
event Create(
    address asset,
    address indexed numeraire,
    address initializer,
    address poolOrHook
);
```

Airlock topic 0:

```text
0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab
```

The distinction matters: the two `Create` events have different argument order, indexing, emitting addresses, and topic 0 values.

### `getAssetData(address)`

Selector:

```text
0x1652e7b7
```

The call returns the launch's numeraire, timelock, governance, migrator, pool initializer, pool/hook, migration pool, amount for sale, total supply, and integrator. Representative call for `$AI`:

```bash
curl --fail --silent --show-error \
  https://rpc.mainnet.chain.robinhood.com \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862","data":"0x1652e7b70000000000000000000000002e8c31162b855a2ffa90f6f8634643ad6f111e18"},"latest"]}'
```

Decoded excerpt:

```text
numeraire        0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec  (NVDA)
migrator         0xba2f330edb16cd8056f5988d8ce19bbc63475a0e
poolInitializer  0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544
poolOrHook       0x2e8c31162b855a2ffa90f6f8634643ad6f111e18
numTokensToSell  1,000,000,000 × 10^18
totalSupply      1,000,000,000 × 10^18
integrator       0x92d435c96e63c43e12d6d0ab28f6b0b04072f765
```

For this Uniswap v4-hook design, the Airlock `pool`/`poolOrHook` value can equal the asset/hook contract. It must not be assumed to be a standalone v3-style pool address. The app's Defined link for `$AI` instead uses pool id:

```text
0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27
```

The integrator value is not stable across all LONG history. The first launch returns integrator `0x8aa7a1dfa6635af2979da4d2bdd51780842e3f99`, while `$AI` returns `0x92d4...2f765`. A single-integrator filter would therefore create false negatives.

## 3. First LONG launch block and launcher transition

The public GraphQL index, ordered by `asset_creation_block ASC`, returns:

```graphql
{
  Asset(limit: 1, order_by: {asset_creation_block: asc}) {
    asset_address
    asset_creation_block
    asset_creation_timestamp
    asset_current_pool
  }
}
```

Observed response:

```json
{
  "data": {
    "Asset": [{
      "asset_address": "0xdb1c7fc020fdd8e7070419022e12e76cbf8a1e18",
      "asset_creation_block": "8145291",
      "asset_creation_timestamp": "2026-07-12T21:56:32+00:00",
      "asset_current_pool": "auction"
    }]
  }
}
```

This was independently confirmed on chain:

```text
Block:       8,145,291 (0x7c498b)
Transaction: 0xa5c3abd2ca8a38ae99d9775a572285e22315e43828a33fb1bbccab14a1d8159f
Launcher:    0x9c88f06b72fcd3cedbef3be7521ee5abd72d0845
Asset:       0xdb1c7fc020fdd8e7070419022e12e76cbf8a1e18
Name/symbol: ap / AP
Numeraire:   0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea (SPCX)
Initializer: 0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544
```

The old launcher was scanned from the Airlock deployment interval through that block and produced no earlier `LaunchCreated` event. The current launcher was also scanned backwards. Its first event is later:

```text
Block:       8,658,626 (0x841ec2)
Timestamp:   2026-07-13T12:13:52Z
Transaction: 0x402f99a65c30372cfc31ab038daa4b8ceff3d52edebefc6f65f20fb7f1c7f16f
Asset:       0x69c68e4c00c6f6e4ac027300293a879be1e11e18
Name/symbol: ap / AP
Numeraire:   AAPL
```

Representative verification query:

```bash
curl --fail --silent --show-error \
  https://rpc.mainnet.chain.robinhood.com \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"address":"0x9c88f06b72fcd3cedbef3be7521ee5abd72d0845","fromBlock":"0x9dead","toBlock":"0x7c498b","topics":["0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b"]}]}'
```

This returns exactly the launch at `0x7c498b` in the scanned interval.

For contrast, `$AI` is a later launch:

```text
Block:       9,721,433 (0x945659)
Timestamp:   2026-07-14T17:48:31Z
Transaction: 0x7632524cd4cec7cabc574b58c54095a2ca33a2a1b037b1486e8b88b79bd3bf1b
Asset:       0x2e8c31162b855a2ffa90f6f8634643ad6f111e18
Numeraire:   NVDA
```

## 4. Auction/launch shape

Finding: **dynamic auction** for the observed Robinhood Chain production path.

Evidence:

- Both the earliest known LONG launch and the `$AI` receipt use `DopplerHookInitializer`.
- The initializer is a Uniswap v4 hook initializer and the receipts contain v4 PoolManager initialization and position events.
- `LaunchCreated` includes `startTime` and `endTime`; the initializer payload/receipt contains tick ranges and auction parameters.
- LONG's current explanatory page describes a descending Dutch phase, a time-versus-supply progress rule, a dynamic floor, and later migration to a standard Uniswap pool.

The old public Frames language describes a multicurve/stacked-liquidity product on an earlier frontend and chain context. It is not the shape shown by the current Robinhood Chain receipts. A tracker should derive shape from `poolInitializer` and decoded init data rather than from marketing labels.

Recommended enum for Phase 2:

```ts
type AuctionShape =
  | "dynamic"
  | "static"
  | "multicurve"
  | "opening"
  | "unknown";
```

Current mapping:

```text
0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544 -> dynamic
```

Unknown initializer addresses must remain `unknown`, not default to `dynamic`.

## 5. Frontend and data API reconnaissance

### Current app

`https://app.long.xyz/` is a Next.js/Turbopack application. On the token list page, 63 script elements were observed, predominantly immutable hashed chunks such as:

```text
/_next/static/chunks/a3853086ad4ee0e0.js
/_next/static/chunks/081288ae94230b8e.js
/_next/static/chunks/turbopack-a1b130d3b31bc027.js
/_next/static/chunks/b7b014b5277a417b.js
```

It also loads PostHog assets from `us-assets.i.posthog.com`. Token media is served from `storage.long.xyz` and local app paths.

The rendered current token list includes stock-anchored tokens such as `$AI`/NVDA, `$BONER`/HIMS, and `$MOO`/MU. The asset addresses are embedded in rendered card style attributes, for example:

```html
style="view-transition-name: token-0x2e8c31162b855a2ffa90f6f8634643ad6f111e18;"
```

This DOM is a useful manual sanity check, not a stable ingestion contract.

### Backend/API endpoint

The API host is live:

```text
https://api.long.xyz/graphql
```

The root page identifies it as a Hive Gateway/Apollo Federation-compatible GraphQL gateway. Public GraphiQL schema introspection exposes, among other fields:

```text
filterTokens(...): TokenFilterConnection
filterPairs(...): PairFilterConnection
getBars(...): BarsResponse
Asset(...): [Asset!]!
AuctionPool(...): [AuctionPool!]!
GraduationPool(...): [GraduationPool!]!
NumerairePrice(...): [NumerairePrice!]!
Token(...): [Token!]!
raw_events(...): [raw_events!]!
```

No application authentication header was required when the query was executed through the public GraphiQL page. The landing page itself advertises only:

```text
content-type: application/json
```

However, a plain command-line request is stopped at the Cloudflare edge:

```bash
curl --fail --silent --show-error \
  --dump-header /tmp/long-api-headers.txt \
  https://api.long.xyz/graphql \
  -H 'content-type: application/json' \
  --data '{"query":"{ __typename }"}'
```

Observed response excerpt:

```text
HTTP/2 403
cache-control: private, max-age=0, no-store, no-cache, must-revalidate
referrer-policy: same-origin
x-frame-options: SAMEORIGIN
server: cloudflare
```

The same issue occurs for ordinary `curl` requests to `app.long.xyz`. A real browser session loads both sites. Phase 2 should not attempt to bypass Cloudflare or make this private frontend contract the source of truth.

### DNS

Probe:

```bash
for h in long.xyz app.long.xyz storage.long.xyz longx.long.xyz api.long.xyz www.long.xyz; do
  echo "$h"
  dig +short "$h" A
  dig +short "$h" CNAME
done
```

Results:

| Host | Result |
|---|---|
| `long.xyz` | Cloudflare anycast `104.20.43.99`, `172.66.162.93` |
| `app.long.xyz` | same Cloudflare anycast pair |
| `storage.long.xyz` | same Cloudflare anycast pair |
| `longx.long.xyz` | same Cloudflare anycast pair |
| `api.long.xyz` | same Cloudflare anycast pair |
| `www.long.xyz` | `sites.framer.app`, then `31.43.160.6` / `31.43.161.6` |

Authoritative nameservers:

```text
cecelia.ns.cloudflare.com
kipp.ns.cloudflare.com
```

The proxied A records deliberately do not reveal origin hosts.

### Farcaster and social metadata

The app homepage currently contains:

```html
<meta name="fc:frame"
  content='{"version":"1","imageUrl":"https://app.long.xyz/cover.png","button":{"title":"Launch on LONG","action":{"name":"Launch on LONG","type":"launch_frame"}}}'>
```

This proves a current frame launch action is advertised in page metadata. The standard `.well-known/farcaster.json` probe could not be verified: direct requests were Cloudflare-blocked and the in-app browser reported `ERR_BLOCKED_BY_CLIENT` for that exact path. No manifest contents are inferred.

Two metadata defects are visible and should not be copied into the tracker:

```text
og:image      http://localhost:3000/og-thumbnail.jpg
twitter:image http://localhost:3000/og-thumbnail.jpg
```

## 6. LongX issuance on Robinhood Chain

The public explorer at `https://longx.long.xyz/` states:

```text
Robinhood Chain (4663)
stats refresh every 30s from the LongX mirror
NAV settles on proveState (~batch cadence)
```

It lists three live vault contracts at reconnaissance time:

| Product | Vault/ERC-20 address |
|---|---|
| NVDA 5x Long (`NVDAx5L`) | `0xac55570c2476bf13ce1517ab20f6d7b660d8400d` |
| NVDA 3x Long (`NVDAx3L`) | `0xf51fb54de60f6e16252e852a5ed0e60b8307606a` |
| NVDA 3x Long legacy (`NVDAx3`) | `0xfa973da4f294085105b61c44e517e98e06d85b5a` |

Read-only ERC-20 probes against the first vault return:

```text
name()        NVDA 5x Long
symbol()      NVDAx5L
decimals()    18
totalSupply() non-zero
eth_getCode   non-empty minimal/proxy runtime
```

Therefore these leveraged assets are issued by contracts on chain 4663; they are not merely off-chain Lighter account labels.

### Which event marks issuance?

Canonical supply issuance is the ERC-20 event:

```solidity
event Transfer(address indexed from, address indexed to, uint256 value);
```

Topic 0:

```text
0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
```

For a settled mint, `from == address(0)` and `to == vault`. Representative transaction:

```text
0xc66fe0a105e2a862e596df4f33b2389341be819701c985d190365717fd61516d
```

The same receipt also emits:

```solidity
event RequestSettled(uint256 requestId, uint256 amountOut, uint256 settlementValue);
```

Topic 0:

```text
0x4f8c78abdea330bc084b3c3f1ceeba23d7278549cd04cfba2907cf7bb7a44035
```

For request `137`, the receipt contains both `Transfer(0x0, vault, shares)` and `RequestSettled(137, ...)`. The minted shares stay in the vault until claimed. Delivery to the receiver happens in a later transaction and emits:

```solidity
event Claimed(uint256 requestId, address receiver, uint256 amount);
```

Topic 0:

```text
0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026
```

Representative claim transaction:

```text
0xcde7382a68de2ab98feda07311cf08eb115a6bde00ebbf01515f6cc8859902f1
```

That receipt emits `Transfer(vault, receiver, shares)` plus `Claimed(137, receiver, shares)`.

Tracking semantics:

| Question | Event/filter |
|---|---|
| Was new LongX supply created? | Vault `Transfer`, `from == 0x0` |
| Which request was settled and at what value? | Vault `RequestSettled` |
| Were settled shares delivered to a user? | Vault `Claimed` plus `Transfer(vault, receiver, amount)` |
| Was supply destroyed on redemption? | Vault `Transfer`, `to == 0x0` |

## 7. Ranked data sources and decision

| Rank | Source | Use | Strength | Failure mode |
|---:|---|---|---|---|
| 1 | Robinhood Chain RPC: both LONG launcher addresses + exact `LaunchCreated` topic | **Primary discovery** | On-chain, LONG-scoped, replayable from block `8,145,291` | Launcher upgrades require address-set maintenance |
| 2 | Airlock receipt logs + initializer logs + `getAssetData` | **Canonical verification/enrichment** | Proves numeraire, initializer, pool/hook, supply, integrator and shape | Airlock/initializer are shared; unsafe as an unfiltered universe |
| 3 | `api.long.xyz/graphql` `Asset`/auction schema | **Fallback reconciliation and metadata enrichment** | LONG-curated, rich timestamps/status fields; found the legacy launcher boundary | Undocumented compatibility; Cloudflare blocks ordinary clients |
| 4 | Official Whetstone deployment registry | Static contract configuration | Canonical upstream contract list | Not a launch feed; may change between releases |
| 5 | Blockscout/Robinscanner | Human verification and transaction links | Useful UI and spot checks | Indexing was stale/inconsistent; API requests returned 403 |
| 6 | Rendered app DOM | Emergency manual sanity check | Shows what users currently see | Unstable markup; incomplete and presentation-oriented |

### Primary implementation contract

For Phase 2, the chain adapter should:

1. scan `LaunchCreated` for both known launcher addresses from block `8,145,291` in bounded ranges;
2. store `(blockNumber, transactionHash, logIndex)` as the idempotent cursor key;
3. fetch the transaction receipt and require matching Airlock and initializer `Create` logs;
4. call `Airlock.getAssetData(asset)` and derive auction shape from the returned initializer;
5. treat GraphQL as a reconciliation feed: any API asset without a matching known-launcher event becomes a visible `unknown launcher` alert, not silently trusted data;
6. tolerate RPC rate limits with bounded concurrency, retry/backoff, resumable cursors, and explicit degraded-state reporting.

### Fallback implementation contract

If the GraphQL endpoint is reachable in the deployment environment, query `Asset` incrementally and verify each returned address on chain. If Cloudflare blocks the environment, the tracker remains operational from RPC alone and displays reduced off-chain metadata. No private Cloudflare tokens, browser-cookie extraction, or anti-bot bypass should be built.

## 8. Remaining uncertainties to carry into Phase 2

- The public GraphQL schema is inspectable, but it is not documented as a stable external API. Treat field changes as expected.
- A future LONG launcher deployment will not be discovered from the two-address allowlist alone. Reconciliation against the LONG `Asset` feed and a visible unknown-launcher alert are required.
- The `.well-known/farcaster.json` manifest could not be read; only the page-level `fc:frame` metadata was verified.
- The frontend's public OG/Twitter image URL currently points at localhost.
- LongX vault implementation source was not needed to prove issuance: runtime code, ERC-20 calls, and real receipts are sufficient. If Phase 2 exposes every custom vault field, obtain and pin the verified ABI before decoding beyond the confirmed event signatures above.

## Phase gate

Phase 1 is complete. Per the supplied execution prompt, work stops here until the result is reviewed. Phase 2 (data access layer) has not started.

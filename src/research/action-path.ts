import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { canaryExitAbi } from "../canary-plan/exit.js";

export const researchPositionManagerAbi = [...canaryExitAbi, ...parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function refundETH() payable",
])];

/** Decode the whole known manager call tree; unknown leaves remain explicit. */
export function decodeResearchActionPath(input: Hex) {
  const leaves: { name: string; args: unknown; selector: string }[] = [];
  let visited = 0;
  const walk = (data: Hex, depth: number): void => {
    if (++visited > 64 || depth > 4) throw new Error("Manager call tree exceeds research bound");
    let decoded;
    try { decoded = decodeFunctionData({ abi: researchPositionManagerAbi, data }); }
    catch { leaves.push({ name: "unknown", args: null, selector: data.slice(0, 10) }); return; }
    if (decoded.functionName === "multicall") {
      const calls = decoded.args[0] as readonly Hex[];
      if (calls.length === 0) leaves.push({ name: "empty_multicall", args: null, selector: data.slice(0, 10) });
      for (const call of calls) walk(call, depth + 1);
    } else leaves.push({ name: decoded.functionName, args: decoded.args, selector: data.slice(0, 10) });
  };
  walk(input, 0);
  const names = leaves.map(l => l.name);
  const known = !names.some(n => n === "unknown" || n === "empty_multicall");
  const economic = leaves.filter(l => l.name !== "refundETH" && l.name !== "burn");
  const sequence = economic.map(l => l.name).join(",");
  const parameter = (leaf: typeof leaves[number]) => (leaf.args as readonly { tokenId?: bigint; liquidity?: bigint; amount0Max?: bigint; amount1Max?: bigint }[])[0]!;
  const decreased = economic.find(l => l.name === "decreaseLiquidity"), collected = economic.find(l => l.name === "collect");
  const samePosition = decreased !== undefined && collected !== undefined && parameter(decreased).tokenId === parameter(collected).tokenId;
  const collectsAll = collected !== undefined && parameter(collected).amount0Max === (1n << 128n) - 1n && parameter(collected).amount1Max === (1n << 128n) - 1n;
  const positiveDecrease = decreased !== undefined && (parameter(decreased).liquidity ?? 0n) > 0n;
  // Burning an NFT is distinct from the pool Burn event. Do not mistake a
  // zero-liquidity fee poke, partial collection or multi-position bundle for our path.
  const burns = leaves.filter(l => l.name === "burn");
  const burnsMatch = burns.length <= 1 && burns.every(l => decreased !== undefined && (l.args as readonly bigint[])[0] === parameter(decreased).tokenId);
  const simpleExit = known && sequence === "decreaseLiquidity,collect" && samePosition && collectsAll && positiveDecrease && burnsMatch;
  const simpleRecenter = known && sequence === "decreaseLiquidity,collect,mint" && samePosition && collectsAll && positiveDecrease && burnsMatch;
  return { leaves, known, sequence, simpleExit, simpleRecenter,
    category: simpleExit ? "decrease_collect" : simpleRecenter ? "decrease_collect_mint_no_swap" : known ? "other_known_manager_path" : "opaque_manager_path",
    limitations: ["Calldata path identity alone does not establish full-position exit, pool isolation, or size comparability",
      "Whole-transaction receipt fees must not be attributed independently to each inner call"] };
}

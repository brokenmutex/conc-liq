import { getAddress, parseAbi } from "viem";

// Official chain-4663 deployment list, checked against current factory/code.
// https://github.com/Uniswap/contracts/blob/main/deployments/4663.md
export const PAPER_ROUTER = getAddress("0xcaf681a66d020601342297493863e78c959e5cb2");
export const PAPER_ROUTER_CODE_HASH = "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc";
export const PAPER_QUOTER = getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
export const PAPER_ACCOUNT = getAddress("0x000000000000000000000000000000000000c0de");
export const NODE_INTERFACE = "0x00000000000000000000000000000000000000c8";
export const paperTokenAbi = parseAbi([
  "function transfer(address to,uint256 amount) returns(bool)",
  "function approve(address spender,uint256 amount) returns(bool)",
  "function balanceOf(address owner) view returns(uint256)",
  "function allowance(address owner,address spender) view returns(uint256)",
  "function decimals() view returns(uint8)",
]);
export const paperRouterAbi = parseAbi([
  "function factory() view returns(address)",
  "function positionManager() view returns(address)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns(bytes[] results)",
]);
export const paperQuoterAbi = parseAbi([
  "function factory() view returns(address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
export const nodeInterfaceAbi = parseAbi([
  "function gasEstimateComponents(address to,bool contractCreation,bytes data) payable returns(uint64 gasEstimate,uint64 gasEstimateForL1,uint256 baseFee,uint256 l1BaseFeeEstimate)",
  "function gasEstimateL1Component(address to,bool contractCreation,bytes data) payable returns(uint64 gasEstimateForL1,uint256 baseFee,uint256 l1BaseFeeEstimate)",
]);

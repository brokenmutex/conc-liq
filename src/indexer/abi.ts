export const v3PoolEventsAbi = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { indexed: false, name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, name: "tick", type: "int24" },
    ],
  },
  {
    type: "event",
    name: "Mint",
    inputs: [
      { indexed: false, name: "sender", type: "address" },
      { indexed: true, name: "owner", type: "address" },
      { indexed: true, name: "tickLower", type: "int24" },
      { indexed: true, name: "tickUpper", type: "int24" },
      { indexed: false, name: "amount", type: "uint128" },
      { indexed: false, name: "amount0", type: "uint256" },
      { indexed: false, name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Collect",
    inputs: [
      { indexed: true, name: "owner", type: "address" },
      { indexed: false, name: "recipient", type: "address" },
      { indexed: true, name: "tickLower", type: "int24" },
      { indexed: true, name: "tickUpper", type: "int24" },
      { indexed: false, name: "amount0", type: "uint128" },
      { indexed: false, name: "amount1", type: "uint128" },
    ],
  },
  {
    type: "event",
    name: "Burn",
    inputs: [
      { indexed: true, name: "owner", type: "address" },
      { indexed: true, name: "tickLower", type: "int24" },
      { indexed: true, name: "tickUpper", type: "int24" },
      { indexed: false, name: "amount", type: "uint128" },
      { indexed: false, name: "amount0", type: "uint256" },
      { indexed: false, name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "amount0", type: "int256" },
      { indexed: false, name: "amount1", type: "int256" },
      { indexed: false, name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, name: "liquidity", type: "uint128" },
      { indexed: false, name: "tick", type: "int24" },
    ],
  },
  {
    type: "event",
    name: "Flash",
    inputs: [
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "amount0", type: "uint256" },
      { indexed: false, name: "amount1", type: "uint256" },
      { indexed: false, name: "paid0", type: "uint256" },
      { indexed: false, name: "paid1", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "IncreaseObservationCardinalityNext",
    inputs: [
      { indexed: false, name: "observationCardinalityNextOld", type: "uint16" },
      { indexed: false, name: "observationCardinalityNextNew", type: "uint16" },
    ],
  },
  {
    type: "event",
    name: "SetFeeProtocol",
    inputs: [
      { indexed: false, name: "feeProtocol0Old", type: "uint8" },
      { indexed: false, name: "feeProtocol1Old", type: "uint8" },
      { indexed: false, name: "feeProtocol0New", type: "uint8" },
      { indexed: false, name: "feeProtocol1New", type: "uint8" },
    ],
  },
  {
    type: "event",
    name: "CollectProtocol",
    inputs: [
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "amount0", type: "uint128" },
      { indexed: false, name: "amount1", type: "uint128" },
    ],
  },
] as const;

export const poolCreatedEvent = {
  type: "event",
  name: "PoolCreated",
  inputs: [
    { indexed: true, name: "token0", type: "address" },
    { indexed: true, name: "token1", type: "address" },
    { indexed: true, name: "fee", type: "uint24" },
    { indexed: false, name: "tickSpacing", type: "int24" },
    { indexed: false, name: "pool", type: "address" },
  ],
} as const;

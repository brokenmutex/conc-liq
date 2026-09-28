import {getAddress,isAddress,type Address} from 'viem';

export type DeploymentSetupDefaults={walletAddress:Address|null};

/** Read the explicit public operator address without consulting signing material. */
export function deploymentSetupDefaults(value:unknown):DeploymentSetupDefaults{
 if(typeof value!=='string'||!isAddress(value))return {walletAddress:null};
 return {walletAddress:getAddress(value)};
}

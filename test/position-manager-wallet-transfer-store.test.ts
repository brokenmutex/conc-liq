import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getAddress} from 'viem';
import {MIGRATIONS} from '../src/storage/migrations.js';
import {MIGRATION_CHECKSUMS} from '../src/storage/migration-checksums.js';
import {POSITION_MANAGER_WALLET_TRANSFER_SQL} from '../src/storage/position-manager-wallet-transfer-migration.js';
import {PostgresPositionManagerWalletTransferStore} from '../src/nft/position-manager-wallet-transfer-store.js';

test('v14 wallet transfer migration is append-only and checksum-bound',()=>{
 assert(MIGRATIONS.length>=14);assert.equal(MIGRATIONS[13],POSITION_MANAGER_WALLET_TRANSFER_SQL);
 assert.equal(createHash('sha256').update(MIGRATIONS[13]!).digest('hex'),MIGRATION_CHECKSUMS[13]);
 assert.match(POSITION_MANAGER_WALLET_TRANSFER_SQL,/PRIMARY KEY \(chain_id, position_manager, wallet_address, start_block\)/);
 assert.match(POSITION_MANAGER_WALLET_TRANSFER_SQL,/PRIMARY KEY \(chain_id, position_manager, wallet_address, start_block, block_number\)/);
 assert.match(POSITION_MANAGER_WALLET_TRANSFER_SQL,/PRIMARY KEY \(chain_id, position_manager, wallet_address, start_block, transaction_hash, log_index\)/);
 assert.match(POSITION_MANAGER_WALLET_TRANSFER_SQL,/lower\(from_address\)=lower\(wallet_address\) OR lower\(to_address\)=lower\(wallet_address\)/);
 assert.doesNotMatch(POSITION_MANAGER_WALLET_TRANSFER_SQL,/ALTER TABLE position_manager_transfer_(cursors|checkpoints|transfers)/);
});

test('wallet transfer store captures an immutable normalized wallet scope',async()=>{
 const wallet=getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
 const other=getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
 const store=new PostgresPositionManagerWalletTransferStore('postgresql://localhost/unused',wallet.toLowerCase() as `0x${string}`);
 try{
  assert.equal(store.walletScope,wallet);
  assert.equal(Reflect.set(store,'walletScope',other),false);
  assert.throws(()=>Object.defineProperty(store,'walletScope',{value:other}),/Cannot redefine property/);
  assert.equal(store.walletScope,wallet);
  assert.throws(()=>new PostgresPositionManagerWalletTransferStore('postgresql://localhost/unused','not-an-address' as `0x${string}`),
   /wallet_scope_invalid/);
 }finally{await store.close();}
});

// check-logs.js
const { ethers } = require('ethers');
const provider = new ethers.providers.JsonRpcProvider(
  process.env.MONAD_RPC_URL ||
    'https://rpc-mainnet.monadinfra.com/rpc/sK3sicffUfrxEa69IHFkE0RBP1nWHgji'
);
const address = '0x2fD13b49F970e8C6D89283056C1c6281214b7EB6'; // pool address
const fromBlock = 38642218; // set to your startBlock
const toBlock = fromBlock + 50000;

async function main() {
  const logs = await provider.getLogs({ address, fromBlock, toBlock });
  console.log('logs found:', logs.length);
  if (logs.length) console.log(logs.slice(0, 5));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

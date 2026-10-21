#!/usr/bin/env node

/**
 * create-school-wallet.js
 * 
 * Utility script to generate a new Stellar keypair for the school wallet.
 * This script also automatically funds the account on the Stellar Testnet.
 * On Mainnet, Friendbot is skipped and funding guidance is printed instead.
 * 
 * Usage:
 *   node scripts/create-school-wallet.js [--network testnet|mainnet]
 *   Or set STELLAR_NETWORK=mainnet
 */

const path = require('path');
const https = require('https');

// Ensure we can find the Stellar SDK from the backend directory
const backendNodeModules = path.join(__dirname, '..', 'backend', 'node_modules');
module.paths.push(backendNodeModules);

// Parse network option from CLI args or environment variable
const args = process.argv.slice(2);
let networkArg;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--network=')) {
    networkArg = args[i].split('=')[1];
  } else if (args[i] === '--network' && args[i + 1]) {
    networkArg = args[i + 1];
    i++;
  } else if (args[i] === '--mainnet') {
    networkArg = 'mainnet';
  } else if (args[i] === '--testnet') {
    networkArg = 'testnet';
  }
}

const network = (networkArg || process.env.STELLAR_NETWORK || 'testnet').toLowerCase();
const isMainnet = network === 'mainnet' || network === 'public';

try {
  const { Keypair } = require('@stellar/stellar-sdk');

  /**
   * Funds the given public key using the Stellar Friendbot on Testnet.
   * @param {string} publicKey 
   * @returns {Promise<any>}
   */
  async function fundWithFriendbot(publicKey) {
    const url = `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`;

    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve({ status: 'success', raw: data });
            }
          } else {
            reject(new Error(`Friendbot failed with status ${res.statusCode}: ${data}`));
          }
        });
      }).on('error', (err) => {
        reject(new Error(`Network error while calling Friendbot: ${err.message}`));
      });
    });
  }

  async function run() {
    // Parse network from CLI arguments or environment variable
    const args = process.argv.slice(2);
    const networkArg = args.find(arg => arg.startsWith('--network='));
    const specifiedNetwork = networkArg
      ? networkArg.split('=')[1].toLowerCase().trim()
      : (process.env.STELLAR_NETWORK || 'testnet').toLowerCase().trim();

    const isMainnet = specifiedNetwork === 'mainnet' || specifiedNetwork === 'public';
    const networkName = isMainnet ? 'Public Mainnet' : 'Testnet';

    console.log('\n🚀 Starting School Wallet Generation...');
    console.log(`🌐 Network: ${networkName}`);
    console.log('─────────────────────────────────────────────────────────');

    try {
      // 1. Generate Keypair
      const pair = Keypair.random();
      const publicKey = pair.publicKey();
      const secretKey = pair.secret();

      console.log('\n✅ New Stellar Keypair Generated:');
      console.log('   Public Key (Address): ', publicKey);
      console.log('   Secret Key:           ', secretKey);
      console.log('─────────────────────────────────────────────────────────');

      // 2. Security Warning
      console.log('\n⚠️  SECURITY WARNING:');
      console.log('   - Keep your Secret Key SAFE and OFFLINE.');
      console.log('   - Never commit or expose secret keys in version control.');
      console.log('   - The StellarEduPay backend only requires the Public Key (SCHOOL_WALLET_ADDRESS).');
      console.log('   - If you lose this secret key, you lose access to the funds!\n');

      // 3. Account Funding
      if (isMainnet) {
        console.log('ℹ️  Mainnet Account Activation Guidance:');
        console.log('   - Friendbot is NOT available on Stellar Public Mainnet.');
        console.log('   - To activate this account, send a minimum of 1.5 - 2 XLM to:');
        console.log(`     ${publicKey}`);
        console.log('   - You can fund it from an exchange (e.g., Binance, Coinbase) or an existing Stellar wallet.');
        console.log('   - Once funded with native XLM, establish a trustline for USDC if accepting stablecoin payments.');
      } else {
        console.log('📡 Funding account via Stellar Friendbot (Testnet only)...');
        try {
          const result = await fundWithFriendbot(publicKey);
          console.log('\n🎉 Account successfully funded on Testnet!');
          if (result.hash) {
            console.log(`   Transaction Hash: ${result.hash}`);
          }
        } catch (fundErr) {
          console.error('\n❌ Friendbot funding failed:');
          console.error(`   ${fundErr.message}`);
          console.log('\n   Note: You can still use this wallet, but you must fund it manually');
          console.log('   at: https://laboratory.stellar.org/#account-creator?network=test');
        }
      }

      console.log('\n─────────────────────────────────────────────────────────');
      console.log('NEXT STEPS:');
      console.log(`1. Copy the Public Key: ${publicKey}`);
      console.log('2. Add it to your backend/.env file:');
      console.log(`   SCHOOL_WALLET_ADDRESS=${publicKey}`);
      if (isMainnet) {
        console.log('   STELLAR_NETWORK=mainnet');
      }
      console.log('3. Restart your backend server.');
      console.log('─────────────────────────────────────────────────────────\n');

    } catch (err) {
      console.error('\n❌ An error occurred during wallet generation:');
      console.error(err.message);
      process.exit(1);
    }
  }

  run();

} catch (err) {
  console.error('\n❌ Failed to load Stellar SDK.');
  console.error('   Please run "cd backend && npm install" first.');
  console.error('   Error detail:', err.message);
  process.exit(1);
}

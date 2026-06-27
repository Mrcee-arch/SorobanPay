// ─── Soroban Network Configuration ────────────────────────────────────────

// Validate and export RPC URL
const RPC_URL_RAW = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org';
export const RPC_URL = RPC_URL_RAW;

export const isValidRpcUrl = (): { valid: boolean; error?: string } => {
  if (!RPC_URL) {
    return { valid: false, error: 'RPC_URL is not defined' };
  }
  try {
    const url = new URL(RPC_URL);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return {
        valid: false,
        error: `RPC URL must use https:// or http://, got: ${url.protocol}`,
      };
    }
    return { valid: true };
  } catch (e) {
    return {
      valid: false,
      error: `RPC URL is malformed: "${RPC_URL}". Expected format: https://example.com`,
    };
  }
};

// Validate and export network passphrase
export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ??
  'Test SDF Network ; September 2015';

export const isValidNetworkPassphrase = (): { valid: boolean; error?: string } => {
  if (!NETWORK_PASSPHRASE) {
    return { valid: false, error: 'NETWORK_PASSPHRASE is not defined' };
  }
  if (!NETWORK_PASSPHRASE.includes('SDF Network')) {
    return {
      valid: false,
      error: `NETWORK_PASSPHRASE should contain "SDF Network", got: "${NETWORK_PASSPHRASE}"`,
    };
  }
  return { valid: true };
};

// Validate and export contract ID
export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? '';

export const isValidContractId = (): { valid: boolean; error?: string } => {
  if (!CONTRACT_ID) {
    return {
      valid: false,
      error: 'CONTRACT_ID is not set. Set NEXT_PUBLIC_CONTRACT_ID in frontend/.env.local',
    };
  }
  if (!CONTRACT_ID.startsWith('C')) {
    return {
      valid: false,
      error: `CONTRACT_ID should start with 'C', got: "${CONTRACT_ID}"`,
    };
  }
  if (CONTRACT_ID.length !== 56) {
    return {
      valid: false,
      error: `CONTRACT_ID should be 56 characters, got: ${CONTRACT_ID.length}`,
    };
  }
  return { valid: true };
};

// Determine network name
export const NETWORK_NAME =
  NETWORK_PASSPHRASE === 'Public Global Stellar Network ; September 2015'
    ? 'Mainnet'
    : 'Testnet';

// ─── Validation utilities ─────────────────────────────────────────────────

export const validateAllConfig = (): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  const rpcCheck = isValidRpcUrl();
  if (!rpcCheck.valid && rpcCheck.error) {
    errors.push(`RPC URL: ${rpcCheck.error}`);
  }

  const passphraseCheck = isValidNetworkPassphrase();
  if (!passphraseCheck.valid && passphraseCheck.error) {
    errors.push(`Network Passphrase: ${passphraseCheck.error}`);
  }

  const contractCheck = isValidContractId();
  if (!contractCheck.valid && contractCheck.error) {
    errors.push(`Contract ID: ${contractCheck.error}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

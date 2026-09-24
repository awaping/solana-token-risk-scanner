/**
 * Module "Autorités du mint" : lecture du compte mint (SPL Token ou
 * Token-2022), des autorités (mint / freeze), des extensions Token-2022
 * dangereuses et des métadonnées (Metaplex ou extension TokenMetadata).
 */
import { PublicKey } from '@solana/web3.js';
import {
  AccountState,
  ExtensionType,
  getDefaultAccountState,
  getExtensionTypes,
  getMintCloseAuthority,
  getPausableConfig,
  getPermanentDelegate,
  getTokenMetadata,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint,
  type Mint,
} from '@solana/spl-token';
import { METAPLEX_METADATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js';
import type { RpcClient } from '../rpc/client.js';
import type { Severity, TokenInfo } from '../types.js';

export interface MetaplexMetadata {
  updateAuthority: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  isMutable: boolean | undefined;
}

/** Dérive l'adresse du compte de métadonnées Metaplex d'un mint. */
export function metaplexMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_METADATA_PROGRAM_ID,
  )[0];
}

/**
 * Décode (partiellement) un compte Metaplex Token Metadata (format Borsh) :
 * key, update_authority, mint, name, symbol, uri, seller_fee, creators,
 * primary_sale_happened, is_mutable.
 */
export function decodeMetaplexMetadata(data: Buffer): MetaplexMetadata | null {
  let offset = 0;
  const need = (len: number) => {
    if (offset + len > data.length) throw new RangeError('metadata tronquée');
  };
  const readPubkey = () => {
    need(32);
    const key = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return key;
  };
  const readString = () => {
    need(4);
    const len = data.readUInt32LE(offset);
    offset += 4;
    need(len);
    const value = data.subarray(offset, offset + len).toString('utf8');
    offset += len;
    return value.replace(/\0/g, '').trim();
  };

  try {
    need(1);
    offset += 1; // key
    const updateAuthority = readPubkey();
    const mint = readPubkey();
    const name = readString();
    const symbol = readString();
    const uri = readString();

    let isMutable: boolean | undefined;
    try {
      need(2);
      offset += 2; // seller_fee_basis_points
      need(1);
      const hasCreators = data.readUInt8(offset) === 1;
      offset += 1;
      if (hasCreators) {
        need(4);
        const count = data.readUInt32LE(offset);
        offset += 4 + count * 34; // Creator { address: Pubkey, verified: bool, share: u8 }
      }
      need(2);
      offset += 1; // primary_sale_happened
      isMutable = data.readUInt8(offset) === 1;
    } catch {
      isMutable = undefined;
    }

    return { updateAuthority, mint, name, symbol, uri, isMutable };
  } catch {
    return null;
  }
}

const isSet = (key: PublicKey | null | undefined): key is PublicKey => !!key && !key.equals(PublicKey.default);

/** Recense les extensions Token-2022 et signale celles qui donnent du pouvoir à un tiers. */
function inspectExtensions(mint: Mint): Pick<TokenInfo, 'extensions' | 'dangerousExtensions' | 'transferFeeBps'> {
  const types = mint.tlvData.length > 0 ? getExtensionTypes(mint.tlvData) : [];
  const extensions = types.map((type) => ExtensionType[type] ?? `Extension#${type}`);
  const dangerous: TokenInfo['dangerousExtensions'] = [];
  let transferFeeBps: number | undefined;

  const permanentDelegate = getPermanentDelegate(mint);
  if (isSet(permanentDelegate?.delegate)) {
    dangerous.push({
      name: 'PermanentDelegate',
      severity: 'critical',
      detail: `le délégué permanent ${permanentDelegate.delegate.toBase58()} peut transférer ou brûler les tokens de n'importe quel holder`,
    });
  }

  const transferHook = getTransferHook(mint);
  if (isSet(transferHook?.programId)) {
    dangerous.push({
      name: 'TransferHook',
      severity: 'warning',
      detail: `le programme ${transferHook.programId.toBase58()} est exécuté à chaque transfert (peut bloquer les ventes)`,
    });
  }

  const transferFee = getTransferFeeConfig(mint);
  if (transferFee) {
    transferFeeBps = Math.max(
      transferFee.newerTransferFee.transferFeeBasisPoints,
      transferFee.olderTransferFee.transferFeeBasisPoints,
    );
    const canChange = isSet(transferFee.transferFeeConfigAuthority);
    const severity: Severity = transferFeeBps >= 1000 ? 'critical' : transferFeeBps > 0 || canChange ? 'warning' : 'info';
    dangerous.push({
      name: 'TransferFeeConfig',
      severity,
      detail: `taxe de transfert de ${(transferFeeBps / 100).toFixed(2)} %${canChange ? ' (modifiable par une autorité)' : ''}`,
    });
  }

  const defaultState = getDefaultAccountState(mint);
  if (defaultState?.state === AccountState.Frozen) {
    dangerous.push({
      name: 'DefaultAccountState',
      severity: 'critical',
      detail: 'les nouveaux comptes sont gelés par défaut (seule une liste blanche peut échanger)',
    });
  }

  const pausable = getPausableConfig(mint);
  if (pausable && isSet(pausable.authority)) {
    dangerous.push({
      name: 'PausableConfig',
      severity: 'critical',
      detail: `l'autorité ${pausable.authority.toBase58()} peut suspendre tous les transferts`,
    });
  }

  if (types.includes(ExtensionType.NonTransferable)) {
    dangerous.push({ name: 'NonTransferable', severity: 'critical', detail: 'token non transférable (invendable)' });
  }

  const closeAuthority = getMintCloseAuthority(mint);
  if (isSet(closeAuthority?.closeAuthority)) {
    dangerous.push({
      name: 'MintCloseAuthority',
      severity: 'warning',
      detail: `le mint peut être fermé par ${closeAuthority.closeAuthority.toBase58()}`,
    });
  }

  if (types.includes(ExtensionType.ConfidentialTransferMint)) {
    dangerous.push({
      name: 'ConfidentialTransferMint',
      severity: 'warning',
      detail: 'transferts confidentiels : une partie des soldes peut être invisible',
    });
  }

  return { extensions, dangerousExtensions: dangerous, transferFeeBps };
}

/**
 * Charge et décode le mint. Lève une erreur explicite si l'adresse n'est pas
 * un mint SPL Token / Token-2022.
 */
export async function analyzeToken(rpc: RpcClient, mint: PublicKey): Promise<TokenInfo> {
  const metadataPda = metaplexMetadataPda(mint);
  const [mintInfo, metadataInfo] = await rpc.call((c) => c.getMultipleAccountsInfo([mint, metadataPda]));

  if (!mintInfo) throw new Error(`Aucun compte trouvé à l'adresse ${mint.toBase58()} (mauvais réseau ou adresse erronée ?)`);

  const programId = mintInfo.owner;
  const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);
  if (!isToken2022 && !programId.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`${mint.toBase58()} n'est pas un mint SPL (propriétaire : ${programId.toBase58()})`);
  }

  let mintData: Mint;
  try {
    mintData = unpackMint(mint, mintInfo, programId);
  } catch {
    throw new Error(`${mint.toBase58()} n'est pas un compte mint (s'agit-il d'un compte de token ou d'une pool ?)`);
  }

  const token: TokenInfo = {
    mint: mint.toBase58(),
    programLabel: isToken2022 ? 'Token-2022' : 'SPL Token',
    programId: programId.toBase58(),
    decimals: mintData.decimals,
    supply: mintData.supply,
    mintAuthority: mintData.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mintData.freezeAuthority?.toBase58() ?? null,
    extensions: [],
    dangerousExtensions: [],
  };

  if (isToken2022) {
    Object.assign(token, inspectExtensions(mintData));
    if (token.extensions.includes('TokenMetadata')) {
      try {
        const meta = await rpc.call((c) => getTokenMetadata(c, mint, 'confirmed', programId));
        if (meta) {
          token.name = meta.name;
          token.symbol = meta.symbol;
          token.metadataUpdateAuthority = isSet(meta.updateAuthority) ? meta.updateAuthority.toBase58() : null;
          token.metadataMutable = token.metadataUpdateAuthority !== null;
        }
      } catch {
        // Métadonnées facultatives : on ignore les erreurs de décodage.
      }
    }
  }

  if (!token.name && metadataInfo) {
    const meta = decodeMetaplexMetadata(metadataInfo.data);
    if (meta) {
      token.name = meta.name;
      token.symbol = meta.symbol;
      token.metadataUpdateAuthority = meta.updateAuthority;
      token.metadataMutable = meta.isMutable;
    }
  }

  return token;
}

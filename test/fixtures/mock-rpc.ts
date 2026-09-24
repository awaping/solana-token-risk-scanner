/**
 * Faux nœud RPC Solana (JSON-RPC over HTTP) pour les tests de bout en bout.
 *
 * Il maintient un état en mémoire (comptes, signatures, transactions) et
 * implémente les méthodes utilisées par le scanner avec le format de réponse
 * attendu par @solana/web3.js.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AccountLayout, MintLayout, ACCOUNT_SIZE, MINT_SIZE, TOKEN_PROGRAM_ID } from '@solana/spl-token';

interface MockAccount {
  owner: PublicKey;
  lamports: number;
  data: Buffer;
}

interface MockSignature {
  signature: string;
  slot: number;
  blockTime: number;
  err: null | object;
}

type Json = Record<string, unknown>;

export const randomKey = () => Keypair.generate().publicKey;

export class MockChain {
  readonly accounts = new Map<string, MockAccount>();
  readonly signatures = new Map<string, MockSignature[]>();
  readonly transactions = new Map<string, Json>();
  readonly calls = new Map<string, number>();
  private slot = 300_000_000;

  setAccount(address: PublicKey, owner: PublicKey, data: Buffer, lamports = 2_039_280): void {
    this.accounts.set(address.toBase58(), { owner, data, lamports });
  }

  addMint(opts: {
    mint: PublicKey;
    supply: bigint;
    decimals?: number;
    mintAuthority?: PublicKey | null;
    freezeAuthority?: PublicKey | null;
  }): void {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: opts.mintAuthority ? 1 : 0,
        mintAuthority: opts.mintAuthority ?? PublicKey.default,
        supply: opts.supply,
        decimals: opts.decimals ?? 6,
        isInitialized: true,
        freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
        freezeAuthority: opts.freezeAuthority ?? PublicKey.default,
      },
      data,
    );
    this.setAccount(opts.mint, TOKEN_PROGRAM_ID, data, 1_461_600);
  }

  addTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, address = randomKey()): PublicKey {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint,
        owner,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    this.setAccount(address, TOKEN_PROGRAM_ID, data);
    return address;
  }

  /** Ajoute une transaction (la plus récente en tête de l'historique de chaque adresse). */
  addTransaction(addresses: PublicKey[], tx: { signer: PublicKey; innerInstructions?: Json[]; blockTime?: number }): string {
    const signature = Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58().slice(0, 20);
    const blockTime = tx.blockTime ?? Math.floor(Date.now() / 1000) - 86_400 * 30;
    const info: MockSignature = { signature, slot: this.slot++, blockTime, err: null };
    for (const address of addresses) {
      const list = this.signatures.get(address.toBase58()) ?? [];
      list.unshift(info);
      this.signatures.set(address.toBase58(), list);
    }
    this.transactions.set(signature, {
      slot: info.slot,
      blockTime,
      version: 0,
      meta: {
        err: null,
        fee: 5000,
        innerInstructions: tx.innerInstructions ? [{ index: 0, instructions: tx.innerInstructions }] : [],
        preBalances: [0],
        postBalances: [0],
        logMessages: [],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [{ pubkey: tx.signer.toBase58(), signer: true, writable: true, source: 'transaction' }],
          instructions: [{ programId: randomKey().toBase58(), accounts: [], data: '' }],
          recentBlockhash: '11111111111111111111111111111111',
        },
      },
    });
    return signature;
  }

  // -------------------------------------------------------------------------
  // Méthodes RPC
  // -------------------------------------------------------------------------

  private encode(account: MockAccount | undefined, slice?: { offset: number; length: number }): Json | null {
    if (!account) return null;
    const data = slice ? account.data.subarray(slice.offset, slice.offset + slice.length) : account.data;
    return {
      data: [data.toString('base64'), 'base64'],
      executable: false,
      lamports: account.lamports,
      owner: account.owner.toBase58(),
      rentEpoch: 0,
      space: account.data.length,
    };
  }

  private context() {
    return { slot: this.slot };
  }

  private tokenAccountsOf(mint: string) {
    return [...this.accounts.entries()]
      .filter(([, a]) => a.owner.equals(TOKEN_PROGRAM_ID) && a.data.length === ACCOUNT_SIZE)
      .map(([address, a]) => ({ address, decoded: AccountLayout.decode(a.data) }))
      .filter((a) => a.decoded.mint.toBase58() === mint);
  }

  handle(method: string, params: unknown[]): unknown {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    switch (method) {
      case 'getAccountInfo':
        return { context: this.context(), value: this.encode(this.accounts.get(params[0] as string)) };

      case 'getMultipleAccounts':
        return {
          context: this.context(),
          value: (params[0] as string[]).map((address) => this.encode(this.accounts.get(address))),
        };

      case 'getBalance':
        return { context: this.context(), value: this.accounts.get(params[0] as string)?.lamports ?? 0 };

      case 'getTokenLargestAccounts': {
        const accounts = this.tokenAccountsOf(params[0] as string)
          .sort((a, b) => (b.decoded.amount > a.decoded.amount ? 1 : -1))
          .slice(0, 20);
        return {
          context: this.context(),
          value: accounts.map((a) => ({
            address: a.address,
            amount: a.decoded.amount.toString(),
            decimals: 6,
            uiAmount: Number(a.decoded.amount) / 1e6,
            uiAmountString: String(Number(a.decoded.amount) / 1e6),
          })),
        };
      }

      case 'getTokenAccountsByOwner': {
        const owner = params[0] as string;
        const { mint } = params[1] as { mint: string };
        const value = this.tokenAccountsOf(mint)
          .filter((a) => a.decoded.owner.toBase58() === owner)
          .map((a) => ({ pubkey: a.address, account: this.encode(this.accounts.get(a.address)) }));
        return { context: this.context(), value };
      }

      case 'getProgramAccounts': {
        const programId = params[0] as string;
        const config = (params[1] ?? {}) as {
          filters?: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string } }>;
          dataSlice?: { offset: number; length: number };
        };
        return [...this.accounts.entries()]
          .filter(([, account]) => account.owner.toBase58() === programId)
          .filter(([, account]) =>
            (config.filters ?? []).every((filter) => {
              if (filter.dataSize !== undefined) return account.data.length === filter.dataSize;
              if (filter.memcmp) {
                const expected = new PublicKey(filter.memcmp.bytes).toBuffer();
                const actual = account.data.subarray(filter.memcmp.offset, filter.memcmp.offset + expected.length);
                return actual.equals(expected);
              }
              return true;
            }),
          )
          .map(([pubkey, account]) => ({ pubkey, account: this.encode(account, config.dataSlice) }));
      }

      case 'getSignaturesForAddress': {
        const { limit = 1000, before } = (params[1] ?? {}) as { limit?: number; before?: string };
        let list = this.signatures.get(params[0] as string) ?? [];
        if (before) list = list.slice(list.findIndex((s) => s.signature === before) + 1);
        return list.slice(0, limit).map((s) => ({ ...s, memo: null, confirmationStatus: 'finalized' }));
      }

      case 'getTransaction':
        return this.transactions.get(params[0] as string) ?? null;

      default:
        throw new Error(`Méthode non simulée : ${method}`);
    }
  }
}

/** Démarre un serveur HTTP JSON-RPC adossé à la chaîne simulée. */
export async function startMockRpc(chain: MockChain): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      let payload: Json;
      try {
        payload = { jsonrpc: '2.0', id: request.id, result: chain.handle(request.method, request.params ?? []) };
      } catch (error) {
        payload = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: (error as Error).message } };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Provides AES-256-GCM encryption and decryption for sensitive credentials.
 * Matches the schema in public.integration_credentials.
 */
export class EncryptionService {
  private readonly masterKey: Buffer;

  constructor(masterKeyHex: string) {
    if (!masterKeyHex || masterKeyHex.length !== 64) {
      throw new Error('Encryption master key must be a 64-character hex string (256 bits).');
    }
    this.masterKey = Buffer.from(masterKeyHex, 'hex');
  }

  /**
   * Encrypts a plaintext string into a ciphertext, IV, and auth tag.
   */
  encrypt(plaintext: string): { iv: string; ciphertext: string; authTag: string } {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);
    
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    
    return {
      iv: iv.toString('hex'),
      ciphertext,
      authTag,
    };
  }

  /**
   * Decrypts a ciphertext using the provided IV and auth tag.
   */
  decrypt(ciphertext: string, ivHex: string, authTagHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    
    decipher.setAuthTag(authTag);
    
    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');
    
    return plaintext;
  }

  /**
   * Helper to encrypt a JSON object.
   */
  encryptJson(obj: Record<string, unknown>): { iv: string; ciphertext: string; authTag: string } {
    return this.encrypt(JSON.stringify(obj));
  }

  /**
   * Helper to decrypt into a JSON object.
   */
  decryptJson<T = Record<string, unknown>>(ciphertext: string, ivHex: string, authTagHex: string): T {
    const plaintext = this.decrypt(ciphertext, ivHex, authTagHex);
    return JSON.parse(plaintext) as T;
  }
}

// Singleton instance helper
let instance: EncryptionService | null = null;
export function getEncryptionService(): EncryptionService {
  if (!instance) {
    const key = process.env.CONNECTOR_ENCRYPTION_KEY;
    if (!key) {
      throw new Error('CONNECTOR_ENCRYPTION_KEY environment variable is not set.');
    }
    instance = new EncryptionService(key);
  }
  return instance;
}

// Engine worker only. The web application retains an encryption-only public key.
import { constants, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { credentialAAD, type CredentialIdentity, type Envelope } from "@inkspect/core/lib/byok/encryption";
import { supportedModel } from "@inkspect/core/lib/byok/catalog";
import { ReviewError } from "@inkspect/core/lib/review-access";

export type ProviderCredential = { provider:string; model:string; api_key:string; max_output_tokens:number };
export const byokReady = () => !!process.env.INKSPECT_BYOK_PRIVATE_KEY_FILE;
export function decryptCredential(envelope: Envelope, identity: CredentialIdentity, key: KeyObject): Buffer {
  const decode = (value: string) => {
    if (typeof value !== 'string' || value.length > 12000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encrypted credential');
    const bytes = Buffer.from(value,'base64');
    if (bytes.toString('base64') !== value) throw new Error('Invalid encrypted credential');
    return bytes;
  };
  if (envelope.version !== 1 || key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 3072
    || envelope.key_id !== createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('hex')) throw new Error('Credential key mismatch');
  const aad=credentialAAD(identity), nonce=decode(envelope.nonce), tag=decode(envelope.tag);
  if(nonce.length!==12 || tag.length!==16) throw new Error('Invalid encrypted credential');
  const dataKey=privateDecrypt({key,oaepHash:'sha256',oaepLabel:aad,padding:constants.RSA_PKCS1_OAEP_PADDING},decode(envelope.wrapped_key));
  try {
    if(dataKey.length!==32) throw new Error('Invalid encryption key');
    const cipher=createDecipheriv('aes-256-gcm',dataKey,nonce); cipher.setAAD(aad); cipher.setAuthTag(tag);
    const secret=Buffer.concat([cipher.update(decode(envelope.ciphertext)),cipher.final()]);
    if(secret.length<16 || secret.length>4096 || [...secret].some(b=>b<33||b>126)) {secret.fill(0);throw new Error('Invalid provider credential');}
    return secret;
  } finally {dataKey.fill(0);}
}

export async function openProviderCredential(organization: string, selection: { credential_id: string; provider: string; model: string }, envelope: Envelope): Promise<ProviderCredential> {
  const model=supportedModel(selection.provider,selection.model);
  if(!model || !byokReady()) throw new ReviewError(503,'BYOK decryption is not configured on the review engine.');
  let secret: Buffer | undefined;
  try {
    const pem=await readFile(process.env.INKSPECT_BYOK_PRIVATE_KEY_FILE!);
    if(pem.length>16384) throw new Error('Invalid key');
    const key=createPrivateKey(pem);
    secret=decryptCredential(envelope,{organization:organization,id:selection.credential_id,provider:selection.provider,model:selection.model},key);
    return {provider:selection.provider,model:selection.model,api_key:secret.toString('utf8'),max_output_tokens:model.output_tokens};
  } catch { throw new ReviewError(503,'The saved provider key could not be opened. Check the engine encryption configuration.'); }
  finally { secret?.fill(0); }
}

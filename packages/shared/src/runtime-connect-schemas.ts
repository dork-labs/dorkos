/**
 * Zod schemas for the runtime connect reads the capability mount serves
 * (DOR-4978): whether a key is saved, the OpenCode "your own key" form, and
 * the DorkOS model setup. Each is secret-free by construction: a saved key is
 * at most its last four characters, and a model setup never carries its key
 * reference.
 *
 * `runtime-connect.ts` re-exports the inferred types, so the client keeps
 * importing them from there.
 *
 * @module shared/runtime-connect-schemas
 */
import { z } from 'zod';
import { DoeInferenceConfigSchema } from './config-schema.js';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** Runtime types the native paste-key path accepts. */
export const CREDENTIAL_RUNTIME_TYPES = ['claude-code', 'codex'] as const;

/**
 * Whether a key is already saved, and the last four characters of it when it is.
 *
 * Four characters is the industry-standard masking a person recognizes their own
 * key by; nothing more of the secret ever leaves the server.
 */
export const SavedKeyStateSchema = z
  .discriminatedUnion('saved', [
    z.object({ saved: z.literal(false) }),
    z.object({
      saved: z.literal(true),
      /** The key's last four characters; empty for a key of four or fewer. */
      last4: z.string().max(4),
    }),
  ])
  .openapi('SavedKeyState');

/** See {@link SavedKeyStateSchema}. */
export type SavedKeyState = z.infer<typeof SavedKeyStateSchema>;

/**
 * Whether a runtime's own pasted key is already saved, for the Claude/Codex key
 * form's "Saved · ends in …" hint. Secret-free: last four characters at most.
 */
export const RuntimeKeyStatusSchema = z
  .object({
    /** Whether a key is saved for this runtime, and its last four characters. */
    key: SavedKeyStateSchema,
  })
  .openapi('RuntimeKeyStatus');

/** See {@link RuntimeKeyStatusSchema}. */
export type RuntimeKeyStatus = z.infer<typeof RuntimeKeyStatusSchema>;

/**
 * What the OpenCode "your own key" form should show when it is reopened: the
 * service that was chosen, the base URL that was entered, and whether a key is
 * already saved. Only the last four characters of a saved key are included.
 */
export const OpenCodeDirectSetupSchema = z
  .object({
    /** The saved service id (`openai`/`anthropic`/…), or `null` when none is saved. */
    providerId: z.string().nullable(),
    /** The saved base URL override, or `null` when none was entered. */
    baseURL: z.string().nullable(),
    /** Whether a key is saved for `providerId`, and its last four characters. */
    key: SavedKeyStateSchema,
  })
  .openapi('OpenCodeDirectSetup');

/** See {@link OpenCodeDirectSetupSchema}. */
export type OpenCodeDirectSetup = z.infer<typeof OpenCodeDirectSetupSchema>;

/** The wire formats DorkOS can talk to a model in. */
export const DoeProtocolSchema = DoeInferenceConfigSchema.shape.protocol;

/** Metadata-only credits choices for one explicit wire protocol. */
export const DoeCreditsCatalogSchema = z
  .object({
    /** The credits endpoint for this protocol, or `null` when no credits link serves it. */
    endpoint: z.string().nullable(),
    models: z.array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        contextWindow: z.number(),
        maxOutputTokens: z.number(),
      })
    ),
  })
  .openapi('DoeCreditsCatalog');

/** See {@link DoeCreditsCatalogSchema}. */
export type DoeCreditsCatalog = z.infer<typeof DoeCreditsCatalogSchema>;

/** The model setup's own fields, as the server keeps them, without its key reference. */
const {
  credentialRef: _credentialRef,
  credentialEndpoint: _credentialEndpoint,
  ...DOE_METADATA_FIELDS
} = DoeInferenceConfigSchema.shape;

/** A DorkOS model setup as a read answers it: never its key reference. */
export const DoeInferenceMetadataSchema = z
  .object(DOE_METADATA_FIELDS)
  .strict()
  .openapi('DoeInferenceMetadata');

/** The saved DorkOS model setup, metadata only. */
export const DoeInferenceStatusSchema = z
  .object({
    /**
     * The setup without its key reference, or `null`: on credits, DorkOS picks
     * the model.
     */
    inference: DoeInferenceMetadataSchema.nullable(),
    /** Whether a key is saved for the setup. */
    hasKey: z.boolean(),
    /** The format DorkOS picks a credits model in, or `null` when it has nothing to pick. */
    autoProtocol: DoeProtocolSchema.nullable(),
  })
  .openapi('DoeInferenceStatus');

/** See {@link DoeInferenceStatusSchema}. */
export type DoeInferenceStatus = z.infer<typeof DoeInferenceStatusSchema>;

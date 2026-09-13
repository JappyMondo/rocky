import { z } from 'zod';

const text = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\r\n\0]+$/);
const optionalText = text.nullable().optional();
const cliIdentity = z.strictObject({
  configDir: optionalText,
  tokenEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .nullable()
    .optional(),
});

/** References only: private key bytes and tokens never belong in a profile. */
export const sourceControlSchema = z.strictObject({
  git: z
    .strictObject({
      name: optionalText,
      email: text
        .regex(/^[^\s<>@]+@[^\s<>@]+$/)
        .nullable()
        .optional(),
      sshKey: optionalText,
      sshAgent: optionalText,
      signingKey: optionalText,
      signingFormat: z.enum(['ssh', 'openpgp', 'x509']).nullable().optional(),
      signingProgram: optionalText,
      signCommits: z.boolean().nullable().optional(),
      signTags: z.boolean().nullable().optional(),
    })
    .optional(),
  github: cliIdentity.optional(),
  gitlab: cliIdentity.optional(),
});

import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "./postgres";
import type {
  AppRepository,
  CreatePersonaInput,
  CreateVoiceAuthorizationInput,
  CreateVoiceProfileInput,
  InsertMemoryInput,
  InsertMessageInput,
  Memory,
  MemoryEmbedding,
  Message,
  Persona,
  User,
  VoiceAuthorization,
  VoiceMeta,
} from "./types";

type PersonaRow = {
  id: string;
  user_id: string;
  name: string;
  relation: string;
  voice_id: string;
  persona_desc: string;
  created_at: Date | string;
};

type UserRow = {
  id: string;
  email: string | null;
  phone: string | null;
  password: string | null;
  created_at: Date | string;
};

type MemoryRow = {
  id: string;
  persona_id: string;
  content: string;
  created_at: Date | string;
};

type MemoryEmbeddingRow = {
  id: string;
  content: string;
  embedding: string | number[] | null;
};

type MessageRow = {
  id: string;
  persona_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date | string;
};

type VoiceProfileRow = {
  id: string;
  user_id: string;
  object_path: string;
  checksum_sha256: string;
  prompt_text: string;
  mime_type: string;
  duration_sec: number | string | null;
  provider_voice_id?: string | null;
  provider_voice_status?: VoiceMeta["providerVoiceStatus"];
  provider_voice_error_code?: string | null;
  provider_voice_updated_at?: Date | string | null;
  created_at: Date | string;
};

type VoiceAuthorizationRow = {
  id: string;
  voice_id: string;
  user_id: string;
  speaker_status: VoiceAuthorization["speakerStatus"];
  basis: VoiceAuthorization["basis"];
  status: VoiceAuthorization["status"];
  reason_code: string | null;
  notice_version: string;
  separate_consent_confirmed: boolean;
  third_party_processing_confirmed: boolean;
  synthetic_disclosure_confirmed: boolean;
  attested_at: Date | string;
  reviewed_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
};

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    relation: row.relation,
    voiceId: row.voice_id,
    personaDesc: row.persona_desc,
    createdAt: toIsoString(row.created_at),
  };
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email || "",
    phone: row.phone || "",
    password: row.password || "",
    createdAt: toIsoString(row.created_at),
  };
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    personaId: row.persona_id,
    content: row.content,
    createdAt: toIsoString(row.created_at),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    personaId: row.persona_id,
    role: row.role,
    content: row.content,
    createdAt: toIsoString(row.created_at),
  };
}

function mapVoiceProfile(row: VoiceProfileRow): VoiceMeta {
  return {
    voiceId: row.id,
    userId: row.user_id,
    objectPath: row.object_path,
    audioFile: row.object_path,
    checksumSha256: row.checksum_sha256,
    promptText: row.prompt_text,
    mimeType: row.mime_type,
    durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
    providerVoiceId: row.provider_voice_id || null,
    providerVoiceStatus: row.provider_voice_status || "not_created",
    providerVoiceErrorCode: row.provider_voice_error_code || null,
    providerVoiceUpdatedAt: row.provider_voice_updated_at
      ? toIsoString(row.provider_voice_updated_at)
      : null,
    createdAt: toIsoString(row.created_at),
  };
}

function mapVoiceAuthorization(row: VoiceAuthorizationRow): VoiceAuthorization {
  return {
    id: row.id,
    voiceId: row.voice_id,
    userId: row.user_id,
    speakerStatus: row.speaker_status,
    basis: row.basis,
    status: row.status,
    reasonCode: row.reason_code,
    noticeVersion: row.notice_version,
    separateConsentConfirmed: row.separate_consent_confirmed,
    thirdPartyProcessingConfirmed: row.third_party_processing_confirmed,
    syntheticDisclosureConfirmed: row.synthetic_disclosure_confirmed,
    attestedAt: toIsoString(row.attested_at),
    reviewedAt: row.reviewed_at ? toIsoString(row.reviewed_at) : null,
    revokedAt: row.revoked_at ? toIsoString(row.revoked_at) : null,
    createdAt: toIsoString(row.created_at),
  };
}

const VOICE_AUTHORIZATION_COLUMNS = `
  id, voice_id, user_id, speaker_status, basis, status, reason_code, notice_version,
  separate_consent_confirmed, third_party_processing_confirmed,
  synthetic_disclosure_confirmed, attested_at, reviewed_at, revoked_at, created_at
`;

function parseVector(value: string | number[]): Float32Array {
  if (Array.isArray(value)) return Float32Array.from(value);
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("Invalid pgvector value");
  }
  if (trimmed === "[]") return new Float32Array();
  return Float32Array.from(trimmed.slice(1, -1).split(",").map(Number));
}

function serializeVector(value: Float32Array): string {
  return `[${Array.from(value).join(",")}]`;
}

export function createPostgresRepository(sql: SqlExecutor): AppRepository {
  async function getCurrentVoiceAuthorizationForUser(
    voiceId: string,
    userId: string,
  ): Promise<VoiceAuthorization | null> {
    const rows = await sql.query<VoiceAuthorizationRow>(
      `SELECT ${VOICE_AUTHORIZATION_COLUMNS}
       FROM voice_authorizations
       WHERE voice_id = $1 AND user_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [voiceId, userId],
    );
    return rows[0] ? mapVoiceAuthorization(rows[0]) : null;
  }

  return {
    async getUserByEmail(email: string): Promise<User | null> {
      const rows = await sql.query<UserRow>(
        `SELECT id, email, phone, password, created_at FROM users WHERE email = $1`,
        [email],
      );
      return rows[0] ? mapUser(rows[0]) : null;
    },

    async createUserByEmail(email: string, passwordHash = ""): Promise<User> {
      const rows = await sql.query<UserRow>(
        `INSERT INTO users (id, email, password)
         VALUES ($1, $2, $3)
         RETURNING id, email, phone, password, created_at`,
        [randomUUID(), email, passwordHash || null],
      );
      if (!rows[0]) throw new Error("Failed to create user");
      return mapUser(rows[0]);
    },

    async setUserPassword(email: string, hash: string): Promise<void> {
      await sql.query(`UPDATE users SET password = $1 WHERE email = $2`, [hash, email]);
    },

    async createVerificationCode(target, code, ttlMinutes = 5): Promise<void> {
      await sql.query(
        `INSERT INTO verification_codes (id, email, phone, code, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 minute'))`,
        [randomUUID(), target.email || null, target.phone || null, code, ttlMinutes],
      );
    },

    async verifyCode(target, code): Promise<boolean> {
      const column = target.email ? "email" : target.phone ? "phone" : null;
      const value = target.email || target.phone;
      if (!column || !value) return false;
      return sql.transaction(async (transaction) => {
        const rows = await transaction.query<{ id: string }>(
          `UPDATE verification_codes
           SET used = true
           WHERE id = (
             SELECT id FROM verification_codes
             WHERE ${column} = $1 AND code = $2 AND used = false AND expires_at > now()
             ORDER BY expires_at DESC
             LIMIT 1
             FOR UPDATE
           )
           RETURNING id`,
          [value, code],
        );
        return Boolean(rows[0]);
      });
    },

    async listPersonas(userId: string): Promise<Persona[]> {
      const rows = await sql.query<PersonaRow>(
        `SELECT id, user_id, name, relation, voice_id, persona_desc, created_at
         FROM personas WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      return rows.map(mapPersona);
    },

    async getPersonaForUser(id: string, userId: string): Promise<Persona | null> {
      const rows = await sql.query<PersonaRow>(
        `SELECT id, user_id, name, relation, voice_id, persona_desc, created_at
         FROM personas
         WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      return rows[0] ? mapPersona(rows[0]) : null;
    },

    async createPersona(input: CreatePersonaInput): Promise<Persona> {
      const rows = await sql.query<PersonaRow>(
        `INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, user_id, name, relation, voice_id, persona_desc, created_at`,
        [input.id, input.userId, input.name, input.relation, input.voiceId, input.personaDesc],
      );
      if (!rows[0]) throw new Error("Failed to create persona");
      return mapPersona(rows[0]);
    },

    async deletePersona(id: string, userId: string): Promise<Persona | null> {
      return sql.transaction(async (transaction) => {
        const rows = await transaction.query<PersonaRow>(
          `DELETE FROM personas
           WHERE id = $1 AND user_id = $2
           RETURNING id, user_id, name, relation, voice_id, persona_desc, created_at`,
          [id, userId],
        );
        return rows[0] ? mapPersona(rows[0]) : null;
      });
    },

    async countPersonasUsingVoice(voiceId: string, userId: string): Promise<number> {
      const rows = await sql.query<{ count: number | string }>(
        `SELECT COUNT(*) AS count FROM personas WHERE voice_id = $1 AND user_id = $2`,
        [voiceId, userId],
      );
      return Number(rows[0]?.count || 0);
    },

    async createVoiceProfile(input: CreateVoiceProfileInput): Promise<VoiceMeta> {
      const rows = await sql.query<VoiceProfileRow>(
        `INSERT INTO voice_profiles
           (id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec,
                   provider_voice_id, provider_voice_status, provider_voice_error_code,
                   provider_voice_updated_at, created_at`,
        [input.voiceId, input.userId, input.objectPath, input.checksumSha256, input.promptText, input.mimeType, input.durationSec],
      );
      if (!rows[0]) throw new Error("Failed to create voice profile");
      return mapVoiceProfile(rows[0]);
    },

    async getVoiceProfileForUser(voiceId: string, userId: string): Promise<VoiceMeta | null> {
      const rows = await sql.query<VoiceProfileRow>(
        `SELECT id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec,
                provider_voice_id, provider_voice_status, provider_voice_error_code,
                provider_voice_updated_at, created_at
         FROM voice_profiles
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [voiceId, userId],
      );
      return rows[0] ? mapVoiceProfile(rows[0]) : null;
    },

    async listVoiceProfiles(userId: string): Promise<VoiceMeta[]> {
      const rows = await sql.query<VoiceProfileRow>(
        `SELECT id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec,
                provider_voice_id, provider_voice_status, provider_voice_error_code,
                provider_voice_updated_at, created_at
         FROM voice_profiles
         WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        [userId],
      );
      return rows.map(mapVoiceProfile);
    },

    async updateVoiceProviderState(voiceId, userId, input): Promise<VoiceMeta | null> {
      const rows = await sql.query<VoiceProfileRow>(
        `UPDATE voice_profiles
         SET provider_voice_id = $3,
             provider_voice_status = $4,
             provider_voice_error_code = $5,
             provider_voice_updated_at = now()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec,
                   provider_voice_id, provider_voice_status, provider_voice_error_code,
                   provider_voice_updated_at, created_at`,
        [voiceId, userId, input.providerVoiceId, input.status, input.errorCode],
      );
      return rows[0] ? mapVoiceProfile(rows[0]) : null;
    },

    async deleteVoiceProfile(voiceId: string, userId: string): Promise<boolean> {
      const rows = await sql.query<{ id: string }>(
        `UPDATE voice_profiles SET deleted_at = now()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [voiceId, userId],
      );
      return Boolean(rows[0]);
    },

    async replaceVoiceAuthorization(
      input: CreateVoiceAuthorizationInput,
    ): Promise<VoiceAuthorization> {
      return sql.transaction(async (transaction) => {
        await transaction.query(
          `UPDATE voice_authorizations
           SET status = 'revoked', revoked_at = now()
           WHERE voice_id = $1 AND user_id = $2
             AND status IN ('pending_review', 'approved')`,
          [input.voiceId, input.userId],
        );
        const rows = await transaction.query<VoiceAuthorizationRow>(
          `INSERT INTO voice_authorizations
             (id, voice_id, user_id, speaker_status, basis, status, reason_code,
              notice_version, separate_consent_confirmed,
              third_party_processing_confirmed, synthetic_disclosure_confirmed, attested_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING ${VOICE_AUTHORIZATION_COLUMNS}`,
          [
            input.id,
            input.voiceId,
            input.userId,
            input.speakerStatus,
            input.basis,
            input.status,
            input.reasonCode,
            input.noticeVersion,
            input.separateConsentConfirmed,
            input.thirdPartyProcessingConfirmed,
            input.syntheticDisclosureConfirmed,
            input.attestedAt,
          ],
        );
        if (!rows[0]) throw new Error("Failed to create voice authorization");
        return mapVoiceAuthorization(rows[0]);
      });
    },

    async getCurrentVoiceAuthorization(voiceId, userId): Promise<VoiceAuthorization | null> {
      return getCurrentVoiceAuthorizationForUser(voiceId, userId);
    },

    async revokeVoiceAuthorization(voiceId, userId): Promise<VoiceAuthorization | null> {
      const rows = await sql.query<VoiceAuthorizationRow>(
        `UPDATE voice_authorizations
         SET status = 'revoked', revoked_at = now()
         WHERE id = (
           SELECT id FROM voice_authorizations
           WHERE voice_id = $1 AND user_id = $2
             AND status IN ('pending_review', 'approved')
           ORDER BY created_at DESC, id DESC
           LIMIT 1
           FOR UPDATE
         )
         RETURNING ${VOICE_AUTHORIZATION_COLUMNS}`,
        [voiceId, userId],
      );
      if (rows[0]) return mapVoiceAuthorization(rows[0]);
      return getCurrentVoiceAuthorizationForUser(voiceId, userId);
    },

    async insertMemory(input: InsertMemoryInput): Promise<void> {
      await sql.query(
        `INSERT INTO memories (id, persona_id, content, embedding)
         VALUES ($1, $2, $3, $4::vector)`,
        [input.id, input.personaId, input.content, serializeVector(input.embedding)],
      );
    },

    async listMemories(personaId: string): Promise<Memory[]> {
      const rows = await sql.query<MemoryRow>(
        `SELECT id, persona_id, content, created_at
         FROM memories WHERE persona_id = $1 ORDER BY created_at`,
        [personaId],
      );
      return rows.map(mapMemory);
    },

    async getMemoryById(id: string) {
      const rows = await sql.query<Pick<MemoryRow, "id" | "persona_id" | "content">>(
        `SELECT id, persona_id, content FROM memories WHERE id = $1`,
        [id],
      );
      return rows[0]
        ? { id: rows[0].id, personaId: rows[0].persona_id, content: rows[0].content }
        : null;
    },

    async deleteMemory(id: string): Promise<void> {
      await sql.query(`DELETE FROM memories WHERE id = $1`, [id]);
    },

    async loadMemoriesWithEmbeddings(personaId: string): Promise<MemoryEmbedding[]> {
      const rows = await sql.query<MemoryEmbeddingRow>(
        `SELECT id, content, embedding::text AS embedding
         FROM memories WHERE persona_id = $1 AND embedding IS NOT NULL`,
        [personaId],
      );
      return rows
        .filter((row): row is MemoryEmbeddingRow & { embedding: string | number[] } => row.embedding !== null)
        .map((row) => ({ id: row.id, content: row.content, embedding: parseVector(row.embedding) }));
    },

    async insertMessage(input: InsertMessageInput): Promise<Message> {
      const rows = await sql.query<MessageRow>(
        `INSERT INTO messages (id, persona_id, role, content)
         VALUES ($1, $2, $3, $4)
         RETURNING id, persona_id, role, content, created_at`,
        [input.id, input.personaId, input.role, input.content],
      );
      if (!rows[0]) throw new Error("Failed to insert message");
      return mapMessage(rows[0]);
    },

    async listMessages(personaId: string, limit = 50): Promise<Message[]> {
      const rows = await sql.query<MessageRow>(
        `SELECT id, persona_id, role, content, created_at
         FROM messages WHERE persona_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [personaId, limit],
      );
      return rows.map(mapMessage).reverse();
    },
  };
}

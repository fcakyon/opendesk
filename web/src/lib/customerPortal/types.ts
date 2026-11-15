export type PortalConfig = { title: string; logo_url: string; color: string; locale: string; locale_fixed: boolean; help_url: string; auth_mode: "local" | "oidc" | "local_and_oidc" };
export type CustomerTicket = { id: string; number: number; subject: string; status: string; created_at: string; updated_at: string };
export type CustomerAttachment = { id: string; filename: string; content_type: string; size_bytes: number; url: string };
export type CustomerMessage = { id: string; direction: "inbound" | "outbound"; body_text: string; created_at: string; attachments: CustomerAttachment[] };
/** A file uploaded for a request, not yet sent. */
export type CustomerUpload = CustomerAttachment & { inline: boolean };
export type Page<T> = { data: T[]; next_cursor: string | null };
export type CustomerToken = { access_token: string; expires_at: string };
export type CustomerLogin = (CustomerToken & { change_password?: false }) | { change_password: true };

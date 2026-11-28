import { useMutation, useQuery } from "@tanstack/react-query";
import { BadgeCheck, MailCheck } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lockup } from "@/components/brand";
import { Notice } from "@/components/auth/parts";
import { LanguageSwitcher, usePublicLocale } from "@/components/help/locale";
import "@/components/help/help.css";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { ChatVerificationPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { tone } from "@/lib/tones";

/** The link's token, from /chat/verify#token=…: the fragment never reaches a server, a log or analytics. */
export function verifyToken(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";
}

/**
 * A chat visitor's verification link (contracts/api.md "Contact verification"). Opening the
 * page changes nothing, since mail scanners open links too: the visitor's click verifies.
 */
export default function ChatVerify() {
  const [token] = useState(() => verifyToken(location.hash));
  const { data, isLoading, isError, isPending } = useQuery(q.chatVerification(token));
  const [done, setDone] = useState<ChatVerificationPage | null>(null);
  const page = done ?? data;
  const { locale, loaded } = usePublicLocale(page?.locale || undefined, !token || !isPending, !!page?.locale_fixed);
  const { t } = useTranslation("public");

  const confirm = useMutation({ mutationFn: () => api.public.confirmChatVerification(token), onSuccess: setDone });

  useEffect(() => {
    if (loaded) document.title = t("chat_verify.page_title");
  }, [loaded, t]);

  return (
    <div data-public-page className="flex min-h-dvh flex-col items-center bg-surface px-4">
      <main className="flex w-full max-w-[420px] flex-1 flex-col justify-center py-16">
        {(token && isLoading) || !loaded ? (
          <div className="flex flex-col items-center gap-3" aria-busy="true">
            <Skeleton className="size-12 rounded-xl" />
            <Skeleton className="h-7 w-60" />
            <Skeleton className="h-3 w-72" />
            <Skeleton className="mt-6 h-10 w-full rounded-lg" />
          </div>
        ) : !token || isError || !page ? (
          <EmptyState lit={2} title={t("chat_verify.invalid_title")} description={t("chat_verify.invalid_body")} />
        ) : page.status === "verified" ? (
          <Verified page={page} fresh={!!done} />
        ) : (
          <div className="animate-rise-in text-center motion-reduce:animate-none">
            <Glyph className={cn(tone.blue.soft, tone.blue.line, tone.blue.text)}>
              <MailCheck className="size-6" aria-hidden />
            </Glyph>
            <p className="label-caps mb-2">
              <bdi>{page.brand_name}</bdi>
            </p>
            <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.03em] text-fg">{t("chat_verify.title")}</h1>
            <p className="mx-auto mt-2 max-w-[360px] text-[13.5px] leading-5 text-fg-3">
              {t("chat_verify.body", { brand: page.brand_name })}
            </p>
            <p className="mono mx-auto mt-4 w-fit max-w-full truncate rounded-md border border-line bg-sunken px-2.5 py-1.5 text-[12.5px] text-fg-2" dir="ltr">
              {page.email}
            </p>
            {confirm.isError && (
              <Notice className="mt-5 text-start">
                {isApiError(confirm.error, "network_error") ? t("chat_verify.offline") : isApiError(confirm.error, "invalid_link") ? t("chat_verify.invalid_body") : t("chat_verify.error")}
              </Notice>
            )}
            <Button variant="primary" size="lg" className="mt-6 w-full" loading={confirm.isPending} onClick={() => confirm.mutate()}>
              {t("chat_verify.button")}
            </Button>
            <p className="mt-3 text-[12px] text-fg-4">{t("chat_verify.not_you")}</p>
          </div>
        )}
      </main>
      <footer className="flex h-14 items-center gap-3 text-xs text-fg-4">
        {!page?.locale_fixed && <LanguageSwitcher current={locale} />}
        <span className="flex items-center gap-1.5">
          {t("footer.powered_by")} <Lockup className="h-[11px]" />
        </span>
      </footer>
    </div>
  );
}

function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("mx-auto mb-5 flex size-12 items-center justify-center rounded-xl border", className)}>{children}</span>;
}

function Verified({ page, fresh }: { page: ChatVerificationPage; fresh: boolean }) {
  const { t } = useTranslation("public");
  const reduce = useReducedMotion();
  const h = tone.green;
  const rise = (delay: number) =>
    reduce ? {} : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.42, delay, ease: [0.16, 1, 0.3, 1] as const } };
  return (
    <div className="flex flex-col items-center text-center" aria-live="polite" data-testid="chat-verified">
      <motion.span
        className={cn("mb-5 flex size-14 items-center justify-center rounded-xl border", h.soft, h.line, h.text)}
        {...(reduce ? {} : { initial: { opacity: 0, scale: 0.86 }, animate: { opacity: 1, scale: 1 }, transition: { type: "spring", stiffness: 420, damping: 28 } })}
      >
        <BadgeCheck className="size-7" aria-hidden />
      </motion.span>
      <motion.h1 className="text-[22px] font-semibold tracking-[-0.03em] text-fg" {...rise(0.1)}>
        {fresh ? t("chat_verify.done_title") : t("chat_verify.already_title")}
      </motion.h1>
      <motion.p className="mt-1.5 max-w-[340px] text-[13.5px] leading-5 text-fg-3" {...rise(0.16)}>
        {t("chat_verify.done_body", { brand: page.brand_name, email: page.email })}
      </motion.p>
    </div>
  );
}

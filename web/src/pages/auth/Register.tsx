import type { TFunction } from "i18next";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Trans, useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthHeading } from "@/app/AuthLayout";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/input";
import { AuthField, completeSignIn, FieldError, Notice, OrDivider, PasswordInput, ProviderButtons, safeNext, StrengthMeter } from "@/components/auth/parts";
import { Turnstile, type TurnstileHandle } from "@/components/auth/Turnstile";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/client";
import { q } from "@/lib/queries";
import { track } from "@/lib/analytics";
import { MAX_ACCOUNTS, useSession } from "@/lib/session";

const route = getRouteApi("/auth/register");

/** An invitation link that sent the visitor here carries its token in `next`. */
function inviteTokenFrom(next: string | undefined): string | undefined {
  const n = safeNext(next);
  if (!n) return undefined;
  const u = new URL(n, location.origin);
  return u.pathname === "/invite" ? (u.searchParams.get("token") ?? undefined) : undefined;
}

const createSchema = (a: TFunction<"auth">) => z.object({
  name: z.string().trim().min(1, a("tellUsYourName")).max(80, a("useAtMost80Characters")),
  email: z.string().trim().min(1, a("enterYourEmail")).email(a("enterAValidEmailAddress")),
  // Counted in characters (code points), as the server counts them.
  password: z
    .string()
    .refine((s) => [...s].length >= 12, a("useAtLeast12Characters"))
    .refine((s) => [...s].length <= 128, a("useAtMost128Characters")),
});
type Values = z.infer<ReturnType<typeof createSchema>>;

export default function Register() {
  const { t: a } = useTranslation("auth");
  const schema = createSchema(a);
  const search = route.useSearch();
  const router = useRouter();
  const { t } = useTranslation("shell");
  // Add-account mode keeps the accounts signed in here.
  const adding = useSession((s) => s.status === "authed") && search.add === "1";
  const add = adding ? "1" : undefined;
  const { data: cfg } = useQuery(q.authConfig());
  const invite = useMemo(() => inviteTokenFrom(search.next), [search.next]);
  const [token, setToken] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "", email: search.email ?? "", password: "" } });
  const password = watch("password");
  const [name, email] = watch(["name", "email"]);
  const [error, setError] = useState<React.ReactNode>(null);
  const turnstile = useRef<TurnstileHandle>(null);

  const closed = cfg?.signup_enabled === false && !invite;

  const submit = handleSubmit(async ({ name, email, password }) => {
    setError(null);
    try {
      const tok = await api.auth.register({
        name: name.trim(),
        email: email.trim(),
        password,
        turnstile_token: token ?? undefined,
        invite_token: invite,
      });
      track("signup_completed", { invited: !!invite });
      router.history.push(await completeSignIn(tok, search.next));
    } catch (err) {
      turnstile.current?.reset();
      if (isApiError(err, "email_taken") || isApiError(err, "conflict"))
        setError(
          <>
             {a("anAccountAlreadyUsesThisEmail")}{" "}
            <Link to="/login" search={{ next: search.next, add }} className="font-medium text-fg underline underline-offset-2">
              {a("logInInstead")}
            </Link>
          </>,
        );
      else if (isApiError(err, "signup_disabled")) setError(a("newSignupsAreTurnedOffAskAnAdmin"));
      else if (isApiError(err, "too_many_accounts")) setError(t("accounts.limit", { count: MAX_ACCOUNTS }));
      else setError(errorMessage(err));
    }
  });

  if (closed)
    return (
      <div>
        <AuthHeading title={a("signupsAreClosed")} subtitle={a("thisOpendeskInstanceOnlyAcceptsNewAccountsBy")} />
        <Button variant="secondary" size="lg" className="w-full" asChild>
          <Link to="/login">{a("backToLogIn")}</Link>
        </Button>
      </div>
    );

  return (
    <div>
      <AuthHeading title={a("createYourAccount")} subtitle={invite ? a("youreJoiningAWorkspaceCreateAnAccountTo") : a("setUpASharedInboxForYourTeam")} />
      {!invite && (
        <>
          <ProviderButtons next={search.next} verb="Sign up" />
          {!!cfg?.providers.length && <OrDivider />}
        </>
      )}
      {error && <Notice className="mb-4">{error}</Notice>}
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <AuthField label={a("name")}>
          {(id) => (
            <div className="flex flex-col gap-1.5">
              <TextInput id={id} inputSize="lg" autoComplete="name" autoFocus placeholder="Ada Lovelace" invalid={!!errors.name} {...register("name")} />
              <FieldError message={errors.name?.message} />
            </div>
          )}
        </AuthField>
        <AuthField label={a("workEmail")}>
          {(id) => (
            <div className="flex flex-col gap-1.5">
              <TextInput id={id} inputSize="lg" type="email" autoComplete="username" readOnly={!!invite && !!search.email} placeholder="you@company.com" invalid={!!errors.email} {...register("email")} />
              <FieldError message={errors.email?.message} />
            </div>
          )}
        </AuthField>
        <AuthField label={a("password")}>
          {(id) => (
            <div className="flex flex-col gap-2">
              <PasswordInput id={id} autoComplete="new-password" invalid={!!errors.password} {...register("password")} />
              {errors.password ? <FieldError message={errors.password.message} /> : <StrengthMeter password={password} userInputs={[name, email]} />}
            </div>
          )}
        </AuthField>
        <Turnstile ref={turnstile} onToken={setToken} action="register" />
        <Button type="submit" variant="primary" size="lg" className="mt-1 w-full" loading={isSubmitting}>
          {a("createAccount")}
        </Button>
        <p className="text-center text-[11.5px] leading-4 text-fg-4">
          <Trans ns="auth" i18nKey="termsAgreement" components={{ terms: <a href="https://opendesk.sh/terms" className="underline underline-offset-2 hover:text-fg-2" />, privacy: <a href="https://opendesk.sh/privacy" className="underline underline-offset-2 hover:text-fg-2" /> }} />
        </p>
      </form>
      <p className="mt-7 text-center text-[12.5px] text-fg-3">
         {a("alreadyHaveAnAccount")}{" "}
        <Link to="/login" search={{ next: search.next, add }} className="font-medium text-fg hover:underline">
          {a("logIn")}
        </Link>
      </p>
      {adding && (
        <p className="mt-3 text-center text-[12.5px] text-fg-3">
          <Link to="/" className="font-medium text-fg-2 transition-colors hover:text-fg">
            {t("accounts.backPlain")}
          </Link>
        </p>
      )}
    </div>
  );
}

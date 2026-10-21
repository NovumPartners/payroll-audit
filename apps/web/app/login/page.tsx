export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const messages: Record<string, string> = {
    not_work_account: "Sign in with your Novum Microsoft 365 account. Personal Microsoft accounts and other tenants are not admitted.",
    not_listed: "Your account is not on the access list. Ask the payroll lead to add you.",
    identity: "This email is bound to a different Microsoft account. Ask the payroll lead.",
    state: "The sign-in request expired or was tampered with. Try again.",
    failed: "Sign-in failed. Try again.",
  };
  return (
    <div className="card" style={{ maxWidth: 480, margin: "60px auto" }}>
      <h1>Payroll QA</h1>
      <p className="muted">Novum Partners pre-run payroll QA. Microsoft 365 sign-in through Novum&apos;s tenant; no local passwords.</p>
      {error && <div className="flash error">{messages[error] ?? "Sign-in failed."}</div>}
      <a className="btn" href="/auth/microsoft/start">Sign in with Microsoft</a>
    </div>
  );
}

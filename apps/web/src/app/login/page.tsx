import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getServerAuthSession } from "~/server/auth";
import LoginPage from "./login-page";
import { getEnabledAuthProviders } from "~/server/better-auth";

export default async function Login() {
  const session = await getServerAuthSession(await headers());

  if (session) {
    redirect("/dashboard");
  }

  return <LoginPage providers={getEnabledAuthProviders()} />;
}

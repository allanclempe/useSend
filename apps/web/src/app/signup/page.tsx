import { redirect } from "next/navigation";
import { getServerAuthSession } from "~/server/auth";
import LoginPage from "../login/login-page";
import { getEnabledAuthProviders } from "~/server/better-auth";

export default async function Login() {
  const session = await getServerAuthSession();

  if (session) {
    redirect("/dashboard");
  }

  return <LoginPage providers={getEnabledAuthProviders()} isSignup />;
}

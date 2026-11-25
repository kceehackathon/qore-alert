import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { qorechain, qorechainTestnet } from "@qorechain/evm";
import { qorexWallet } from "@qorechain/qorex-rainbowkit";
import { createConfig, http } from "wagmi";

const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [() => qorexWallet({ pollAccountsOnFocus: true }), injectedWallet],
    },
  ],
  {
    appName: "QoreAlert",
    projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "unused",
  },
);

export const config = createConfig({
  chains: [qorechainTestnet, qorechain],
  connectors,
  transports: {
    [qorechainTestnet.id]: http(
      import.meta.env.VITE_QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host",
    ),
    [qorechain.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}

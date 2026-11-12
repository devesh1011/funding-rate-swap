"use client";

import { createContext, useContext } from "react";
import { NETS, type NetConfig } from "@/lib/config";

const NetContext = createContext<NetConfig>(NETS.mainnet);

/** The deployment this trading page talks to (mainnet or testnet). */
export const NetProvider = NetContext.Provider;
export const useNet = () => useContext(NetContext);

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./lib/auth";
import "./styles/global.css";

import BrowsePage from "./pages/BrowsePage";
import EventPage from "./pages/EventPage";
import TicketsPage from "./pages/TicketsPage";
import SignInPage from "./pages/SignInPage";
import ClaimPage from "./pages/ClaimPage";
import OrganizePage from "./pages/OrganizePage";
import ScannerPage from "./pages/ScannerPage";
import CreateEventPage from "./pages/CreateEventPage";
import AdminPage from "./pages/AdminPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<BrowsePage />} />
            <Route path="/e/:code" element={<EventPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/inv/:token" element={<ClaimPage />} />
            <Route path="/organize" element={<OrganizePage />} />
            <Route path="/organize/new" element={<CreateEventPage />} />
            <Route path="/organize/:id" element={<OrganizePage />} />
            <Route path="/organize/:id/checkin" element={<ScannerPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<BrowsePage />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

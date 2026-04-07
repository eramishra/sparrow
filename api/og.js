/**
 * Dynamic OG image — 1200x630 PNG for social sharing
 * GET /api/og
 */

import { ImageResponse } from "@vercel/og";

export const config = { runtime: "edge" };

export default function handler() {
  return new ImageResponse(
    {
      type: "div",
      props: {
        style: {
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          padding: "80px",
          background: "#0d0d0d",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        children: [
          // Badge
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "10px",
                background: "rgba(252,82,0,0.12)",
                border: "1px solid rgba(252,82,0,0.3)",
                borderRadius: "99px",
                padding: "6px 18px",
                marginBottom: "32px",
              },
              children: {
                type: "span",
                props: {
                  style: { color: "#fc5200", fontSize: "18px", fontWeight: "700" },
                  children: "🏃 AI Fitness Coach on Telegram",
                },
              },
            },
          },
          // Heading
          {
            type: "div",
            props: {
              style: {
                fontSize: "96px",
                fontWeight: "800",
                color: "#f0f0f0",
                lineHeight: "1",
                letterSpacing: "-3px",
                marginBottom: "28px",
              },
              children: [
                { type: "span", props: { children: "🐦 Sparrow" } },
              ],
            },
          },
          // Subtext
          {
            type: "div",
            props: {
              style: { fontSize: "32px", color: "#888888", maxWidth: "800px", lineHeight: "1.4" },
              children: "Connects to Strava · Builds your weekly plan · Coaches you after every workout",
            },
          },
          // Bottom strip
          {
            type: "div",
            props: {
              style: {
                position: "absolute",
                bottom: "60px",
                left: "80px",
                display: "flex",
                alignItems: "center",
                gap: "32px",
              },
              children: [
                {
                  type: "div",
                  props: {
                    style: { fontSize: "22px", color: "#555555", fontWeight: "600" },
                    children: "talktosparrow.vercel.app",
                  },
                },
                {
                  type: "div",
                  props: {
                    style: { width: "6px", height: "6px", borderRadius: "50%", background: "#333" },
                  },
                },
                {
                  type: "div",
                  props: {
                    style: { fontSize: "22px", color: "#555555", fontWeight: "600" },
                    children: "@isparo_bot on Telegram",
                  },
                },
              ],
            },
          },
        ],
      },
    },
    { width: 1200, height: 630 }
  );
}

# --- Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci

# App source
COPY . .

# Vite build-time args (embedded into the bundle)
ARG VITE_BASE=/
ARG VITE_API_URL=https://agri-api.farmhost.in
ENV VITE_BASE=${VITE_BASE}
ENV VITE_API_URL=${VITE_API_URL}

# Helpful log
RUN echo ">>> Building with VITE_API_URL=${VITE_API_URL}  VITE_BASE=${VITE_BASE}"

# Build (Vite default output: /dist)
RUN npm run build

# --- Runtime: tiny Node image + serve (no Nginx needed)
FROM node:20-alpine AS runtime
WORKDIR /app

# Install a tiny static server and curl for healthcheck
RUN npm i -g serve && apk add --no-cache curl

# Copy build artifacts
COPY --from=build /app/dist ./dist

# Non-root for safety
RUN adduser -D appuser
USER appuser

# Expose internal port; Synology RP will forward to this
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/ || exit 1

# Serve with SPA fallback
CMD ["serve", "-s", "dist", "-l", "3000"]
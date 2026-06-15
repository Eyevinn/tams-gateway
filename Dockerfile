ARG NODE_IMAGE=node:20-alpine

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# Default port; the app reads PORT, so this matches the exposed port. OSC can
# override PORT at runtime.
ENV PORT=8080
RUN corepack enable
EXPOSE 8080
RUN mkdir /app
RUN chown node:node /app
USER node
WORKDIR /app
COPY --chown=node:node ["package.json", "pnpm-lock.yaml", "tsconfig*.json", "./"]
COPY --chown=node:node ["src", "./src"]
# Delete prepare script to avoid errors from husky
RUN pnpm pkg delete scripts.prepare \
    && pnpm install --prod --frozen-lockfile
CMD [ "pnpm", "run", "start" ]

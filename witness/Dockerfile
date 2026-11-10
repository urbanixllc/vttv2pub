# VesTally Blockchain Ledger witness in a container. The program lives in /app; your key and your
# copy of the Ledger live in /data (a volume), so updating the image never touches them.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY witness.mjs ./
RUN mkdir /data && chown node:node /data
USER node
WORKDIR /data
ENTRYPOINT ["node", "/app/witness.mjs"]
CMD ["run"]

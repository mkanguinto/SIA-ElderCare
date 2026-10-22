FROM nodered/node-red:4.1.7-22
# Flows, settings and the tested flow logic live outside /data, so a new image always brings new flows
# (/data is the volume for Node-RED's runtime state: context, sessions).
WORKDIR /opt/eldercare
COPY --chown=node-red:node-red settings.js flows.json ./
COPY --chown=node-red:node-red src ./src
USER node-red
# The image's entrypoint runs "npm start -- --userDir /data <CMD>", and npm start passes $FLOWS as the flow file.
ENV FLOWS=/opt/eldercare/flows.json
WORKDIR /usr/src/node-red
EXPOSE 1880
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:1880/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["--settings", "/opt/eldercare/settings.js"]

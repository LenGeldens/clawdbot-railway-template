# OpenClaw 2026.10.7 op Railway: herstel en beheer

Dit draaiboek beschrijft de controles voor de bestaande Railway-service. Het is
geen bewijs dat een deployment, accounttest of WhatsApp-test al is geslaagd.
Commando's hieronder zijn voor de **Railway-container** met zijn bestaande
`/data`-volume, behalve wanneer een tijdelijk testvolume expliciet is genoemd.
Een opdracht op de laptop verandert de productiecontainer niet.

## Voorwaarden en grenzen

- Gebruik het bestaande project, de bestaande service en het bestaande volume.
- Bewaar `OPENCLAW_STATE_DIR=/data/.openclaw` en de bestaande workspace onder
  `/data/workspace`. Controleer ook de werkelijk opgeslagen workspace-instelling.
- Laat de wrapper luisteren op Railway's `PORT`; controleer dat de publieke
  target port daarbij past. De interne gateway blijft op loopback, poort 18789.
- Houd setup-authenticatie, gateway-authenticatie, WhatsApp-allowlist en
  groepsbeperkingen intact. Start nooit twee gateways met dezelfde
  WhatsApp-credentials.
- Bekijk geen volledige auth-bestanden of omgevingsdumps. Bewaar back-ups en
  uitvoer met accountgegevens uitsluitend privé; commit ze niet.
- Voer geen automatische `doctor --fix`, login of modelwijziging uit bij elke
  containerstart. Eerst een herstelpunt, daarna een eenmalige gecontroleerde
  migratie. Ook een eerste start van een nieuwe release kan opslag migreren.

## 1. Leg de oude toestand vast en maak een herstelpunt

Controleer de actieve Railway-deployment, image/commit, volledige mislukte
buildlog, volume-mount, resource-instellingen, publieke target port en wrapper-
luisterpoort. Noteer de oude CLI-versie en gatewaystatus zonder tokens:

```sh
openclaw --version
openclaw gateway status
openclaw channels status --probe
```

Gebruik alleen opties die de **oude** installatie zelf ondersteunt. De nieuwe
back-upcommando's hieronder mogen niet worden verondersteld op 2026.3.8.

Maak vóór de eerste schrijvende start met 2026.10.7 een volledige privéback-up
van `/data/.openclaw` en `/data/workspace`, plus eventuele externe `$include`-
configuratie en andere expliciet ingestelde agentpaden. Gebruik een
opslag-/volume-snapshot met passende consistentie, of stop de wrapper en zijn
gateway gecontroleerd en archiveer de complete directories. Alleen
`openclaw.json` en `auth-profiles.json` zijn onvoldoende.

Een gewone kopie van een live SQLite-bestand kan recente transacties missen.
Bewaar bij een gestopte, ruwe bestandsback-up de **hele directory**, inclusief
eventueel aanwezige `-wal`- en `-shm`-bestanden. Verwijder WAL-bestanden niet.
Een ondersteunde SQLite-back-up maakt juist een consistente database-snapshot;
daar mogen geen oude WAL-bestanden achteraf aan worden toegevoegd.

Bewaar de back-up buiten de geback-upte directories, met beperkte
bestandsrechten. Controleer bestandsgrootte, archiefintegriteit en herstel naar
een aparte tijdelijke directory. Start die kopie niet met WhatsApp ingeschakeld.
Noteer welke oude image bij dit herstelpunt hoort. De eerdere laptopdownload
is pas een bruikbaar herstelpunt nadat inhoud, tijdstip en volledigheid privé
zijn gecontroleerd.

Na succesvolle migratie ondersteunt 2026.10.7 een eigen volledige back-up:

```sh
openclaw backup create --output /data/backups --verify
```

Dit omvat standaard state, configuratie, credentials, sessies en workspaces,
met SQLite-snapshots. Gebruik voor een herstelpunt geen `--only-config` en geen
`--no-include-workspace`. Een back-up op hetzelfde volume beschermt niet tegen
verlies van dat volume; bewaar ook een beveiligde kopie buiten de service.

## 2. Controleer de gebouwde installatie vóór productie

Test de container eerst met een nieuw tijdelijk volume, zonder productie-auth
of WhatsApp-sessie. Controleer CLI-versie, wrapper-start, HTTP en healthchecks,
en het daadwerkelijk opstarten van de interne gateway. Een bereikbare
setup-pagina bewijst geen werkende gateway of modelrequest.

Release 2026.10.7 bevat de native `codex`-plugin met `@openai/codex` **0.160.0**.
Controleer dat de plugin, zijn runtime-afhankelijkheden en het native Linux-
platformpakket in de image aanwezig zijn. Gebruik de door OpenClaw beheerde
executable; installeer niet daarnaast willekeurig de nieuwste globale Codex.
`appServer.command` en `OPENCLAW_CODEX_APP_SERVER_BIN` horen niet naar een oude
of ontbrekende executable te wijzen.

Controleer op de nieuwe installatie:

```sh
openclaw --version
openclaw plugins list
openclaw config validate
```

De wrapper moet dezelfde installatie gebruiken als `openclaw`. Een CLI-
versiecontrole alleen bewijst niet welke installatie de wrapper start.

## 3. Migreer bestaande Codex-auth en configuratie

Voer dit pas uit na het gecontroleerde herstelpunt. Stop gedurende een
opslagmigratie de actieve gateway via de wrapper/procesbeheerder, zodat deze
niet direct opnieuw start. Gebruik geen tweede gateway op hetzelfde volume.

```sh
openclaw doctor --fix
openclaw config validate
openclaw models auth list --agent main --provider openai --json
openclaw models auth order get --agent main --provider openai
```

Lees de reparatie-uitvoer. In deze release migreert doctor oude `codex/*` en
`openai-codex/*` modelverwijzingen, auth-profiel-ID's, auth-volgorde en
verouderde runtimepinnen. Gemigreerde modelverwijzingen krijgen modelgebonden
`agentRuntime.id: "codex"`. Een expliciete GPT-5.5-keuze wordt niet automatisch
Astra. Een teruggekeerde fout is geen toestemming om credentials te wissen.

De actuele auth- en sessiestate kan nu in SQLite staan, waaronder
`/data/.openclaw/agents/main/agent/openclaw-agent.sqlite`. De oude JSON-bestanden
zijn niet langer de volledige waarheid. Bewaar ook de globale state-database
en alle andere bestanden onder de state-directory.

Bij default `homeScope: "agent"` bewaart Codex zijn configuratie en threads in
`<agentDir>/codex-home`, doorgaans
`/data/.openclaw/agents/main/agent/codex-home`. Dit valt onder het bestaande
volume. OpenClaw beheert de OAuth-credentials zelf en geeft kortlevende tokens
in het geheugen aan de Codex app-server door. Een gekopieerde
`codex-home/auth.json` is in deze modus geen ondersteunde runtime-login.
Schakel geen gedeelde laptop-/user-home in om dit te omzeilen.

Alleen als het gemigreerde profiel ontbreekt of niet meer kan vernieuwen:

```sh
openclaw models auth login --provider openai --device-code --agent main
```

Dit is de ondersteunde ChatGPT/Codex-login op een headless server. De eigenaar
rondt de officiële inlogpagina privé af. Vraag geen wachtwoord, token,
callbackcode of auth-bestand in een chat. Gebruik geen `--force`, want dat kan
bestaande providerprofielen verwijderen. Een Pro-upgrade vereist niet bewezen
automatisch opnieuw inloggen; controleer eerst de bestaande accountstatus en
echte modelaanvraag. Login zonder `--set-default` bewaart de bestaande modelkeuze.

## 4. Selecteer uitsluitend de abonnementsroute

Inventariseer eerst opgeslagen auth-profielen, hun **type**, de effectieve
auth-volgorde en bestaande model-/accountpinnen. `openai:` kan zowel OAuth als
een API-key betekenen. Gebruik uitsluitend het daadwerkelijk aangetroffen
ChatGPT/Codex OAuth-profiel; neem geen profiel-ID uit een voorbeeld over.

Stel ook de per-agent auth-volgorde in op alleen dat profiel:

```sh
openclaw models auth order set --agent main --provider openai ECHT_OAUTH_PROFIEL_ID
```

Deze opgeslagen per-agent volgorde gaat vóór `auth.order.openai` in de config.
Controleer beide. Bewaar niet-gebruikte credentials veilig; voeg geen API-key-
back-up toe. Controleer bovendien dat de gateway geen actieve API-keyroute via
`OPENAI_API_KEY`, `CODEX_API_KEY`, inline providerkeys, SecretRefs of een oude
sessiepin kan kiezen. Schakel zulke inference-fallbackbronnen uit voor deze
service zonder hun waarden te printen. Alleen een OAuth-profiel bovenaan een
lijst zetten is geen verbod op API-fallback.

Merge dit minimale beleidsvoorbeeld in de bestaande config **nadat toegang tot
het gekozen model is vastgesteld**. Vervang het profiel-ID door de echte waarde.
Vervang nooit het gehele configuratiebestand door dit fragment:

```json5
{
  auth: {
    order: { openai: ["ECHT_OAUTH_PROFIEL_ID"] },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: { appServer: { homeScope: "agent" } },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-6-astra", fallbacks: [] },
      models: {
        "openai/gpt-6-astra": { agentRuntime: { id: "codex" } },
        "openai/gpt-6.1-sol": { agentRuntime: { id: "codex" } },
      },
    },
  },
}
```

Als `plugins.allow` al bestaat, voeg `codex` aan die bestaande lijst toe.
Behoud andere benodigde plugins, waaronder WhatsApp. De expliciete runtime
laat een ontbrekende/onbruikbare Codex-harness falen. Vermijd afwijkende
endpoints en zelf ingestelde providerrequest-parameters: sommige authored
request-overrides kunnen een gedeclareerde OpenClaw-runtimefallback gebruiken.
Controleer daarom altijd de werkelijk uitgevoerde runtime.

Na gatewaystart, ontdek de modellen van de geselecteerde account opnieuw:

```sh
openclaw models list --agent main --provider openai --refresh --json
openclaw models status --agent main --json
```

Controleer daarnaast `/codex models`, `/codex account` en `/codex status` in de
betreffende privéconversatie. De catalogus moet bij dezelfde agent, account en
runtime horen. Statische/offline catalogusregels en een OAuth-status `OK`
bewijzen geen accounttoegang. Een lege/401/403-catalogus niet aanvullen met
verzonnen modelnamen.

Kies eerst `openai/gpt-6-astra`. Alleen wanneer Astra aantoonbaar niet
beschikbaar is, mag expliciet `openai/gpt-6.1-sol` worden gekozen als deze
account die aanbiedt. Voeg Sol niet als automatische fallback toe. Voor beide
is `medium` een gedocumenteerd redeneerniveau; gebruik het alleen wanneer de
live native catalogus het ondersteunt. `none` is voor beide niet ondersteund.

Het globale default kan na verificatie met `openclaw models set MODELREF`
worden gewijzigd. Dat commando accepteert geen `--agent` en wijzigt niet alle
per-agent of per-sessie selecties. Controleer daarom ook `agents.entries.main`
(en eventuele andere werkelijk geconfigureerde agent), modelpolicy,
fallbacks, thinking-overrides en de opgeslagen WhatsApp-sessie.

## 5. Test dezelfde gateway en de bestaande WhatsApp-conversatie

Zoek privé de juiste bestaande sessiesleutel, zonder gesprekken te publiceren:

```sh
openclaw sessions --agent main --json
```

Controleer in die conversatie `/status`, `/codex binding` en `/codex account`.
Een globale modelwijziging ruimt een oude gebruikerspin niet op. Gebruik
`/model default -s` om de modeloverride terug te zetten naar het geverifieerde
agentdefault en `/think default` om een oude thinking-override te wissen.
Een compatibele auth-pin kan daarbij blijven bestaan: controleer deze apart.
Bij een bewust aangehechte native thread kan ook zijn opgeslagen model leidend
zijn; wijzig die gericht via de ondersteunde `/codex model`-bediening en
controleer de binding opnieuw. Wis geen sessie of geschiedenis om een test
groen te krijgen.

Voer nu via de actieve gateway één kleine aanvraag op diezelfde sessie uit.
Gebruik de werkelijk gevonden sessiesleutel en geef **geen** `--model` mee:
de test moet juist de effectieve opgeslagen WhatsApp-selectie controleren.

```sh
openclaw agent --agent main --session-key 'ECHTE_WHATSAPP_SESSIESLEUTEL' \
  --message 'Installatietest: bereken 17 maal 19 en antwoord in een korte Nederlandse zin. Gebruik geen tools.' \
  --timeout 120 --json
```

Gebruik hierbij geen `--local` en geen `agent exec`: die hebben een ander
uitvoeringspad. Zonder `--deliver` schrijft deze technische test geen uitgaand
WhatsApp-bericht. Bewaar alleen een geredigeerd resultaat: succesvolle
exitcode, inhoudelijk antwoord (323), werkelijk provider/model,
runtime/harness, profielidentiteit zonder persoonsgegevens en geselecteerde
authenticatiemodus. Combineer de runmetadata met `/status`, `/codex account`
en `/codex binding` van dezelfde sessie. Het bewijs moet ChatGPT/Codex-
abonnementsauth tonen; een `openai/`-prefix, een prijsveld of afwezige
API-keyvariabele alleen is onvoldoende. Als metadata de route niet vaststelt,
blijft abonnementsauth **niet geverifieerd**.

Een losse `models status --probe` is geen vervanging voor deze gatewaytest.
In 2026.10.7 vereist die probe exclusief eigendom van de statedirectory;
voer hem niet naast de actieve gateway uit.

Controleer daarna de verbinding:

```sh
openclaw gateway status
openclaw channels status --probe
```

Laat de eigenaar vervolgens vanaf zijn bestaande toegestane WhatsApp-account
één bericht sturen: **"Installatietest: wat is 17 maal 19?"** De end-to-endtest
slaagt alleen bij een inhoudelijk ontvangen antwoord. `connected` of
`typing` is onvoldoende. Behoud de eigen-nummer-allowlist en bestaande
groepsbeperkingen.

## 6. Herstart en oplevering

Herstart de bestaande Railway-service gecontroleerd, zonder nieuw volume.
Controleer daarna CLI-versie, gateway, volume, gekozen model/runtime/auth,
en WhatsApp-status opnieuw. Er mag geen nieuwe onboarding of QR-koppeling
nodig zijn. Controleer dat de vooraf bestaande conversatie en workspace nog
aanwezig zijn. Laat één vervolgbericht in dezelfde WhatsApp-conversatie
inhoudelijk beantwoorden; dat verifieert herstel van de hele keten na herstart.

Noteer afzonderlijk, met tijdstip en bewijs:

| Onderdeel | Vereist bewijs |
| --- | --- |
| Code gerepareerd | Reparatiecommit/PR en geslaagde repositorytests |
| Build geslaagd | Volledige containerbuild, exacte image en CLI-versie |
| Deployment actief | Railway-deployment-ID, commit/image, HTTP en gateway |
| Modelaanvraag geslaagd | Antwoord en werkelijk model/runtime/auth van dezelfde gateway |
| WhatsApp geslaagd | Ontvangen inhoudelijk antwoord van toegestaan account |
| Persistentie geslaagd | Dezelfde state/koppeling en werkend antwoord na herstart |

Vul niet-geteste onderdelen in als **niet uitgevoerd**, met de concrete reden.
Een gepubliceerde GitHub-commit is geen deploymentbewijs. Een draaiende
deployment is geen bewijs dat de account Astra kan gebruiken.

## Rollback

1. Stop de wrapper/gateway en voorkom automatische herstart tijdens herstel.
2. Bewaar eerst een apart privéherstelpunt van de mislukte nieuwe toestand.
3. Herstel de volledige **bij de oude image horende** state en workspace uit
   het herstelpunt van vóór de upgrade. Herstel naar gecontroleerde paden;
   meng geen nieuwe SQLite-databases of WAL-bestanden met oude state.
4. Zet de bijbehorende oude image/commit terug in dezelfde service, met
   hetzelfde volume, PORT en toegangsbeleid. Voer met die oude image geen
   migratie van de nieuwe config uit.
5. Controleer gateway, WhatsApp en inhoudelijk antwoord opnieuw.

Alleen de image terugzetten is onvoldoende: doctor en database-upgrades kunnen
de persistente configuratie, profielnamen en opslag veranderen. Meld ook dat
berichten en bestanden van ná het gekozen herstelpunt niet automatisch in de
teruggezette toestand zitten; bewaar die nieuwe snapshot voor gericht herstel.

## Geverifieerde bronnen

De tagbronnen hieronder horen bij 2026.10.7; de live documentatie kan later
afwijken. Zo noemt de live Codex-documentatie inmiddels een nieuwere bundled
Codex dan de 0.160.0 uit deze tag.

- [OpenAI setup, tag 2026.10.7](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/providers/openai/setup.md)
- [Runtime en migratie, tag 2026.10.7](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/providers/openai/runtimes.md)
- [Modellen en redeneerniveaus, tag 2026.10.7](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/providers/openai/models.md)
- [Codex package en versie](https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/codex/package.json)
- [Native auth en isolatie](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/plugins/codex-harness-reference/auth.md)
- [Accountgebonden modelontdekking](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/plugins/codex-harness-reference/model-discovery.md)
- [Model- en auth-CLI](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/cli/models.md)
- [Gateway-agenttest](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/cli/agent.md)
- [Sessies](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/cli/sessions.md)
- [Back-up en SQLite](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/cli/backup.md)
- [Live OpenClaw OpenAI-documentatie](https://docs.openclaw.ai/providers/openai)
- [Officiële OpenAI modeldocumentatie](https://developers.openai.com/codex/models)
- [Officiële OpenAI authenticatie](https://developers.openai.com/codex/auth)

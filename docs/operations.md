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
- Stel Railway **Draining seconds** in op `30`, ook in het dashboard wanneer
  de service `railway.toml` niet toepast. De wrapper wacht bij SIGTERM/SIGINT
  maximaal 25 seconden op afsluiting van de gateway, zodat databases kunnen
  sluiten voordat de container eindigt. Railway geeft standaard geen
  afsluittermijn; zie de [officiële teardown-documentatie](https://docs.railway.com/deployments/reference#singleton-deploys).
  Houd **Overlap seconds** op `0`; gebruik geen overlappende gateways met
  dezelfde WhatsApp-koppeling.
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

**De bestaande versie 2026.3.8 valt buiten het directe upgradevenster.** De
release-instructies schrijven voor installaties van vóór juli 2026 eerst
2026.9.5 en zijn Doctor-migraties voor. Versie 2026.10.7 importeert onder meer
`credentials/oauth.json`, `plugins/installs.json`, oude task-/flow-/plugin-
databases en sommige oude configuratiesleutels niet meer. Ook 2026.9.7 verwijst
voor deze oudere bronnen naar 2026.9.5; 2026.9.7 is geen universele vervanging.
Sommige resterende runtime-JSON-bestanden, sandboxregistries of een oud
geheugenindexschema vragen daarnaast expliciet om 2026.9.7. Volg de gemelde
bron en bridgeversie, met een nieuw controlepunt tussen de stappen.

Inspecteer vóór een eerste schrijvende start alleen de aanwezigheid van deze
bronnen en de betreffende configuratiesleutels, zonder credentials te tonen.
Voer de bridge in de gestopte container tegen dezelfde paden uit, met een
afzonderlijk vastgelegde CLI-versie en de benodigde kanaalplugins. Een
nieuwe CLI bovenop al door 2026.10.7 gemigreerde databases terugzetten is geen
veilige bridge: herstel dan eerst de volledige passende oude back-up.

Gateway-startup importeert algemene legacy-state **niet**; dat doet Doctor.
De officiële OpenClaw-image voert Doctor in zijn entrypoint uit, maar deze
Railway-wrapper heeft een eigen entrypoint. Een niet-interactieve gateway-start
kan daarom met exit 78 weigeren en `/setup/healthz` ongezond laten. Gebruik een
expliciete, gecontroleerde migratie vóór de eerste gatewaystart; vertrouw niet
op een console die pas na een geslaagde deployment beschikbaar komt. Een
Railway pre-deploy command is hiervoor ongeschikt: dat heeft geen volume-mount.

### Eenmalige migratie in deze Railway-image

Voor de gecontroleerde route 2026.3.8 → 2026.9.5 → 2026.10.7 bevat deze image
een afzonderlijke, vastgepinde 2026.9.5 CLI onder
`/opt/openclaw-bridge/node_modules/openclaw/openclaw.mjs`. Schakel de
pre-startstap uitsluitend na controle van het herstelpunt expliciet in met:

```text
OPENCLAW_MIGRATION=2026.10.7-from-prejuly
```

De wrapper wacht hiermee vóór bootstrap, configwijzigingen en gatewaystart.
De stap controleert de exacte CLI-versies en een vrije interne gatewaypoort,
archiveert de complete gestopte state en workspace inclusief aanwezige
SQLite-sidecars en controleert het tar-archief. Daarna voert hij eerst de
bridge-Doctor en configvalidatie uit en vervolgens dezelfde stappen met
2026.10.7. Hij kiest geen model en voert geen modelaanvraag uit.

Offline onderhoud betekent hier dat de gateway en andere schrijvers gestopt
zijn; het betekent niet dat netwerktoegang uitstaat. Doctor kan een verlopen
of bijna verlopen OAuth-login vernieuwen. Bewaar daarom ook de nieuwste state
bij een rollback: tokenrotatie kan de in de oude back-up bewaarde refresh-token
ongeldig maken. Controleer na herstel eerst de bestaande login; gebruik pas
bij een aangetoonde authenticatiefout de officiële loginprocedure hieronder.

Archief, checksum, fasejournal en privélog staan onder
`/data/backups/openclaw-2026.10.7-from-prejuly/`. Directoryrechten zijn 0700;
archief, log en journal zijn 0600. Standaard worden alleen fasemeldingen
naar Railway-logs geschreven, geen Doctor-uitvoer. De ondersteunde automatische
layout heeft state en workspace als aparte directories direct onder hetzelfde
volume; afwijkende externe paden vereisen gerichte handmatige onderhoudsstappen.

Alleen nadat beide Doctor-runs en beide configvalidaties exit 0 hebben,
krijgen de state-directory en het externe journal bij elkaar horende
afrondingsbewijzen. Latere starts slaan de migratie over. Een onderbroken of
mislukte fase blokkeert automatisch herhalen: inspecteer het privélog en het
journal. Start nooit 2026.9.5 opnieuw op deels door 2026.10.7 geschreven state.
Er is geen automatische restore en geen automatisch wissen van een journal.
Een door Doctor genoemde 2026.9.7-verplichting blijft een expliciete
onderhoudsstap; de helper slaat die fout niet over.

Verwijder de opt-in na succesvolle migratie en controles. Stel de eerste
deployment-healthcheck ruim genoeg in voor back-up plus beide migraties.
`stage: "complete"` bewijst alleen deze migratiestappen; gateway, abonnement,
model, WhatsApp en persistentie moeten hieronder nog afzonderlijk worden getest.

Voer dit pas uit na het gecontroleerde herstelpunt. Stop gedurende een
opslagmigratie de actieve gateway via de wrapper/procesbeheerder, zodat deze
niet direct opnieuw start. Gebruik geen tweede gateway op hetzelfde volume.

```sh
openclaw doctor --fix
openclaw config validate
openclaw models auth list --agent main --provider openai --json
openclaw models auth order get --agent main --provider openai
```

Voor de gecontroleerde headless stap zijn de ondersteunde opties
`openclaw doctor --fix --non-interactive --no-workspace-suggestions`.
Combineer deze reparatie niet met `--json`: dat selecteert de read-only
lintmodus en wordt samen met `--fix` geweigerd. Gebruik geen `--force`,
`--yes` of `--generate-gateway-token`. Controleer exitstatus én de resterende
waarschuwingen; exit 0 is nog geen bewijs van modeltoegang of kanaalgezondheid.

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

In **2026.10.7** is `agents.entries.<id>` de actuele schema-vorm; `agents.list`
is legacy. De CLI kan oude list-paden nog vertalen, maar schrijf nieuwe patches
met `entries`. Zowel `agents.defaults` als een `agents.entries.main`-record
ondersteunen `model`, `models` en `thinkingDefault`.

Als `main` een eigen model of runtimeoverride heeft, voeg na modelverificatie
dit deel aan de bovenstaande patch toe:

```json5
{
  agents: {
    entries: {
      main: {
        model: { primary: "openai/gpt-6-astra", fallbacks: [] },
        thinkingDefault: "medium",
        models: {
          "openai/gpt-6-astra": { agentRuntime: { id: "codex" } },
        },
      },
    },
  },
}
```

Bewaar de samengestelde patch zonder credentials in een privé tijdelijk
bestand op de server. De ondersteunde patchwriter merge objecten recursief,
vervangt arrays en verwijdert paden bij `null`. Laat `channels`, `bindings` en
gatewaybeveiliging buiten deze modelpatch:

```sh
openclaw config patch --file /tmp/openclaw-route.patch.json --dry-run
openclaw config patch --file /tmp/openclaw-route.patch.json
openclaw config validate --json
```

Controleer een bestaande modelpolicy afzonderlijk: voeg alleen het gekozen
exacte model toe indien nodig, zonder beperkingen op te heffen. Volg de
herstartmelding van de CLI en vergelijk na toepassing de WhatsApp-policies en
allowlist met het herstelpunt.

### Machineleesbare catalogus met runtime en redeneerniveaus

De gewone `models list --json` vereenvoudigt de modelregels. Gebruik deze
RPC wanneer ook de door het account aangeboden redeneerniveaus nodig zijn:

```sh
openclaw gateway call models.list \
  --params '{"agentId":"main","provider":"openai","view":"all","refresh":true,"includeDetails":true}' \
  --timeout 210000 --json
```

Inspecteer `providerOutcomes`, `refreshFailed` en per model `available`,
`agentRuntime`, `runtimeChoices`, `thinkingLevels` en `thinkingDefault`.
Voor het account van een bestaande conversatie kan `sessionKey` aan de
parameters worden toegevoegd. Een expliciete `authProfileId` kan ook, maar
mag niet samen met `sessionKey` worden meegegeven.

Het ondersteunde Codex-account-RPC accepteert uitsluitend een opgeslagen
abonnementslogin en vraagt die op met `authRequirement: "subscription"`:

```sh
openclaw gateway call codex.accountUsage \
  --params '{"agentId":"main","profileId":"ECHT_OAUTH_PROFIEL_ID"}' \
  --timeout 30000 --json
```

Deze actie vereist `operator.admin`. Gebruik de bestaande lokale
gateway-authenticatie; plaats geen gatewaytoken op de commandoregel. Het
resultaat kan privé-account-/quotagegevens bevatten, maar geen credentials.
Ook dit is accountbewijs, geen bewijs dat de generatieaanvraag slaagt.

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

Voor een gericht herstel zonder extra WhatsApp-commando's ondersteunt deze
release onderstaande RPC. Vul de werkelijk gevonden key en huidige
session-ID in; `expectedSessionId` voorkomt dat een inmiddels vervangen
sessie per ongeluk wordt aangepast:

```sh
openclaw gateway call sessions.patch \
  --params '{"key":"ECHTE_WHATSAPP_SESSIESLEUTEL","agentId":"main","expectedSessionId":"HUIDIGE_SESSION_ID","model":null,"agentRuntime":null,"thinkingLevel":null}' \
  --json
```

Dit herstelt model/runtime/thinking-selectie naar de configuratie. Het is geen
reset van de gesprekshistorie en geen bewijs dat een compatibele auth-pin
verdwenen is. Controleer die accountselectie apart.

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

De gateway-JSON-envelop bevat de runmetadata doorgaans onder
`result.meta.agentMeta`: lees daar `provider`, `model`, `agentHarnessId`,
`runtimeModelSelection` en `credentialSource`. In deze release geeft
`credentialSource.kind: "profile"` bewust geen profiel-ID of credentialtype;
dat veld alleen bewijst dus geen OAuth. Controleer ook `result.meta.error`,
`aborted`, de terminale status en eventuele `fallbackAttempts`. Projecteer
alleen deze benodigde velden en de testtekst voor een opleverrapport; publiceer
geen volledige prompt-/gespreksdiagnostiek.

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
   Bewaar ook het migratiejournal buiten de state-directory apart en schakel
   `OPENCLAW_MIGRATION` uit. Hergebruik een afgerond journal niet voor oude
   herstelde state; de state-side receiptcontrole weigert deze combinatie.
4. Zet de bijbehorende oude image/commit terug in dezelfde service, met
   hetzelfde volume, PORT en toegangsbeleid. Voer met die oude image geen
   migratie van de nieuwe config uit.
5. Controleer gateway, WhatsApp en inhoudelijk antwoord opnieuw.

Alleen de image terugzetten is onvoldoende: doctor en database-upgrades kunnen
de persistente configuratie, profielnamen en opslag veranderen. Meld ook dat
berichten en bestanden van ná het gekozen herstelpunt niet automatisch in de
teruggezette toestand zitten; bewaar die nieuwe snapshot voor gericht herstel.
Een oude auth-back-up garandeert na OAuth-tokenrotatie geen geldige login.
Controleer die na herstel en deel of kopieer geen tokens via chat of logs.

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
- [Configpatches en agents.entries](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/cli/config.md)
- [Schema van agentrecords](https://github.com/openclaw/openclaw/blob/v2026.10.7/src/config/zod-schema.agent-entry-base.ts)
- [Schema van gerichte sessiewijzigingen](https://github.com/openclaw/openclaw/blob/v2026.10.7/packages/gateway-protocol/src/schema/sessions-patch.ts)
- [Account-RPC met verplichte abonnementsauth](https://github.com/openclaw/openclaw/blob/v2026.10.7/extensions/codex/src/account-usage-runtime.ts)
- [Back-up en SQLite](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/cli/backup.md)
- [Upgradevenster en tussenversies](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/install/updating.md#upgrading-very-old-versions)
- [Legacy-state en entrypoint](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/cli/doctor/state-migrations.md)
- [Gateway-startup laat algemene import aan Doctor](https://github.com/openclaw/openclaw/blob/v2026.10.7/src/commands/startup-config-preflight.ts)
- [Railway pre-deploy heeft geen volume](https://docs.railway.com/deployments/pre-deploy-command)
- [Live OpenClaw OpenAI-documentatie](https://docs.openclaw.ai/providers/openai)
- [Officiële OpenAI modeldocumentatie](https://developers.openai.com/codex/models)
- [Officiële OpenAI authenticatie](https://developers.openai.com/codex/auth)

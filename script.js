document.addEventListener('DOMContentLoaded', function () {
  console.log("KANBAN WIDGET SCRIPT: DOMContentLoaded event fired.");

 // --- INÍCIO DO BLOCO DE INTERNACIONALIZAÇÃO (I18N) ---
  let currentLang = 'pt'; // Idioma padrão
  let translations = {};   // Objeto para armazenar as traduções carregadas

  // Função para buscar e carregar um arquivo de idioma
  async function loadLanguage(langCode) {
    // Se já carregamos este idioma antes, não faz nada
    if (translations[langCode]) {
      return;
    }
    try {
      // CORREÇÃO: Adiciona o caminho da pasta 'locales/'
      const response = await fetch(`locales/${langCode}.json`);
      if (!response.ok) {
        throw new Error(`Network response was not ok for locales/${langCode}.json`);
      }
      // Armazena as traduções no nosso objeto principal
      translations[langCode] = await response.json();
      console.log(`Successfully loaded language: ${langCode}`);
    } catch (error) {
      console.error(`Failed to load language file for ${langCode}:`, error);
      // Como fallback, se pt.json falhar, podemos ter um mini dicionário em inglês aqui
      if (!translations.en) {
        translations.en = { "error_loading_translations": "Error loading translations. Please check the console." };
      }
    }
  }
  
  // A nova função tradutora que usa o objeto carregado
  function _(key) {
    const langPack = translations[currentLang] || translations['en'] || {};
    return langPack[key] || key; // Retorna a tradução ou a chave como fallback
  }
    
  // A função para traduzir o conteúdo estático permanece a mesma
  function translatePageContent() {
      document.querySelectorAll('[data-i18n]').forEach(element => {
          const key = element.dataset.i18n;
          const translation = _(key);
          const textNode = Array.from(element.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
          if (textNode) {
              textNode.textContent = (element.nodeName === 'BUTTON' && (element.textContent.includes('⚙️') || element.querySelector('i, span'))) ? ' ' + translation : translation;
          } else {
              element.textContent = translation;
          }
      });
      document.querySelectorAll('option[data-i18n]').forEach(opt => {
        opt.textContent = _(opt.dataset.i18n);
      });
  }
  // --- FIM DO BLOCO DE INTERNACIONALIZAÇÃO (I18N) ---

  const CURRENT_CONFIG_KEY_FOR_GRIST = 'kanbanWidgetConfig_v18_reflist_manager';
  const CARDS_PER_PAGE = 25;

  /*****************************************************************
   * 1.  Módulos reutilizáveis
   *****************************************************************/

  window.GristDataManager = (function () {
    const state = { tables: null, columns: null, allTableMetas: {} };
    async function loadMeta() {
      const p = [];
      try {
        if (!state.tables) { p.push(grist.docApi.fetchTable('_grist_Tables').then(d => state.tables = d).catch(e => { console.error("GDM: Erro _grist_Tables", e); throw e; })); }
        if (!state.columns) { p.push(grist.docApi.fetchTable('_grist_Tables_column').then(d => state.columns = d).catch(e => { console.error("GDM: Erro _grist_Tables_column", e); throw e; }));}
        if (p.length) { await Promise.all(p); }
      } catch (error) { console.error("GDM: Falha loadMeta.", error); throw error; }
    }
    function numericId(tableId) { if (!state.tables || !state.tables.tableId) { console.error("GDM.numericId: state.tables não carregado."); return null; } const idx = state.tables.tableId.findIndex(t => String(t) === String(tableId)); return idx === -1 ? null : String(state.tables.id[idx]); }
    function columnsOf(numId) {
      if (!numId || !state.columns || !state.columns.colId) { console.warn("GDM.columnsOf: numId ou state.columns inválido."); return []; }
      const cols = []; const m = state.columns; const tidKey = m.parentId ? 'parentId' : 'tableId'; const cidKey = m.colId ? 'colId' : 'columnId';
      for (let i = 0; i < m[cidKey].length; i++) {
        if (String(m[tidKey][i]) !== String(numId)) { continue; }
        const colType = String(m.type[i]); let referencedTableId = null;
        if (colType.startsWith('Ref:') || colType.startsWith('RefList:')) { referencedTableId = colType.split(':')[1]; }
        const rawFormula = m.formula?.[i] ?? ''; const isFormula = String(rawFormula).trim() !== '';
        let wopts = {}; if (m.widgetOptions?.[i]) { try { wopts = JSON.parse(m.widgetOptions[i]); } catch (e) { /* ignore */ } }
        let choices = [];
        if (Array.isArray(wopts.choices) && wopts.choices.length) { choices = wopts.choices.slice(); }
        else if (typeof wopts.choiceOptions === 'object') { choices = Object.keys(wopts.choiceOptions); }
        if (!choices.length && m.choices?.[i]) { const raw = m.choices[i]; if (Array.isArray(raw)) { choices = raw[0] === 'L' ? raw.slice(1) : raw; } else if (typeof raw === 'string' && raw.startsWith('L')) { choices = raw.substring(1).split(','); } }
        let displayColIdForSelf = null;
        if (m.displayCol?.[i] != null) { const dispNumId = m.displayCol[i]; const displayColIndex = m.id.findIndex(idVal => String(idVal) === String(dispNumId)); if (displayColIndex !== -1) { displayColIdForSelf = String(m[cidKey][displayColIndex]); } }
        cols.push({ id: String(m[cidKey][i]), label: String(m.label[i] || m[cidKey][i]), type: colType, referencedTableId: referencedTableId, isFormula, choices, widgetOptions: wopts, displayColId: displayColIdForSelf });
      }
      return cols;
    }
    function colToRows(colData) { if (!colData || typeof colData.id === 'undefined' || colData.id === null) { console.warn("GDM.colToRows: colData ou colData.id inválido/nulo."); return []; } const rows = []; const keys = Object.keys(colData); const n = colData.id.length; for (let i = 0; i < n; i++) { const r = {}; keys.forEach(k => r[k] = colData[k][i]); rows.push(r); } return rows; }
    async function fetchAll() { const defaultReturn = { mainTable: { nameId: null, numericId: null, columns: [] }, allData: {}, allTablesList: [] }; try { await loadMeta(); const tableId = await grist.selectedTable.getTableId(); if (!tableId) { console.warn("GDM.fetchAll: Nenhuma tabela selecionada."); return defaultReturn; } const numId = numericId(tableId); if (!numId) { console.warn(`GDM.fetchAll: numId não encontrado para '${tableId}'.`); return { ...defaultReturn, mainTable: { nameId: tableId, numericId: null, columns: [] }, allTablesList: getAllTableIdsAndNames() }; } const cols = columnsOf(numId); let data = []; try { const rawData = await grist.docApi.fetchTable(tableId); data = colToRows(rawData); } catch (fetchError) { console.error(`GDM.fetchAll: Erro fetch dados '${tableId}'.`, fetchError); } return { mainTable: { nameId: tableId, numericId: numId, columns: cols }, allData: { [tableId]: data }, allTablesList: getAllTableIdsAndNames() }; } catch (error) { console.error("GDM.fetchAll: Erro busca.", error); return defaultReturn; } }
    function getAllTableIdsAndNames() { if (!state.tables || !state.tables.tableId) { console.warn("GDM.getAllTableIdsAndNames: state.tables não carregado."); return []; } return state.tables.tableId.map((id, index) => ({ id: String(id), name: String(state.tables.label?.[index] || state.tables.tableId[index] || id) })).filter(t => !t.id.startsWith('_grist_')); }
    async function getTableSchema(tableId) { if (state.allTableMetas[tableId]) { return state.allTableMetas[tableId]; } await loadMeta(); const numTableId = numericId(tableId); if (!numTableId) { console.warn(`GDM.getTableSchema: ID numérico não encontrado para tableId: ${tableId}`); return { tableId: tableId, columns: [] }; } const cols = columnsOf(numTableId); const schema = { tableId: tableId, columns: cols }; state.allTableMetas[tableId] = schema; return schema; }
    return { fetchAll, getAllTableIdsAndNames, getTableSchema, colToRows, columnsOf };
  })();

  window.WidgetConfigManager = (function() {
    const KANBAN_DEFAULTS_INTERNAL = {
        language: 'pt', // <-- NOVO PADRÃO ADICIONADO AQUI
        kanbanDefiningColumnId: null,
        restrictAdjacentMove: false,
        laneWipLimits: {},
        cardSortCriteria: [{ columnId: null, direction: 'asc', displayType: '' }, { columnId: null, direction: 'asc', displayType: '' }, { columnId: null, direction: 'asc', displayType: '' }],
        visual: { centerColumns: false, columnWidthPercent:  25, columnMinWidth: 200, columnMaxWidth: 400, columnColor: '#F8F9FA', cardColor: '#FFFFFF', cardShadow: true, backgroundType: 'solid', solidBackgroundColor: '#E9ECEF', gradientColor1: '#E9ECEF', gradientColor2: '#D8DCDF', gradientDirection: 'to right', drawerFontColor: '#333333', cardTitleFontColor: '#333333', cardFieldsFontColor: '#333333' },
        rules: {}
    };
    const FIELD_DEFAULTS_INTERNAL = { visible: true, editable: true, position: 0, card: false, cardPosition: 0, showLabel: true, useFormatting: false, refListFieldConfigs: {} };
    let currentConfig = JSON.parse(JSON.stringify(KANBAN_DEFAULTS_INTERNAL));

    return {
      loadConfig: async () => {
        const stored = await grist.getOption(CURRENT_CONFIG_KEY_FOR_GRIST);
        currentConfig = {
            ...JSON.parse(JSON.stringify(KANBAN_DEFAULTS_INTERNAL)),
            ...(stored || {}),
            laneConfigs: stored?.laneConfigs || {},
            visual: { ...JSON.parse(JSON.stringify(KANBAN_DEFAULTS_INTERNAL.visual)), ...(stored?.visual || {}) },
            rules: { ...JSON.parse(JSON.stringify(KANBAN_DEFAULTS_INTERNAL.rules)), ...(stored?.rules || {}) }
        };
        if (stored?.visual && typeof stored.visual.cardShadow !== 'undefined') { currentConfig.visual.cardShadow = Boolean(stored.visual.cardShadow); } else { currentConfig.visual.cardShadow = KANBAN_DEFAULTS_INTERNAL.visual.cardShadow; }
      },
      saveConfig: async () => { await grist.setOption(CURRENT_CONFIG_KEY_FOR_GRIST, currentConfig); },
      // --- INÍCIO DAS NOVAS FUNÇÕES ---
      getLanguage: () => currentConfig.language || 'pt',
      setLanguage: (langCode) => { currentConfig.language = langCode; },
      // --- FIM DAS NOVAS FUNÇÕES ---
      getVisualConfig: () => ({ ...currentConfig.visual }),
      setVisualConfig: (vis) => { currentConfig.visual = { ...KANBAN_DEFAULTS_INTERNAL.visual, ...currentConfig.visual, ...vis }; if (typeof vis.cardShadow === 'boolean') { currentConfig.visual.cardShadow = vis.cardShadow; } },
      getKanbanDefiningColumn: () => currentConfig.kanbanDefiningColumnId,
      setKanbanDefiningColumn: (colId) => { currentConfig.kanbanDefiningColumnId = colId; },
      getRestrictAdjacentMove: () => currentConfig.restrictAdjacentMove,
      setRestrictAdjacentMove: (v) => { currentConfig.restrictAdjacentMove = Boolean(v); },
      getLaneWipLimit: (lv) => ({maxVisible: 0,maxAllowed: 0,...currentConfig.laneWipLimits?.[String(lv)]}),
      setLaneWipLimit: (lv, lim) => { currentConfig.laneWipLimits = currentConfig.laneWipLimits || {}; currentConfig.laneWipLimits[String(lv)] = {maxVisible: parseInt(lim.maxVisible, 10) || 0, maxAllowed: parseInt(lim.maxAllowed, 10) || 0};},
      getCardSortCriteria: () => currentConfig.cardSortCriteria.map(c => ({ ...c })),
      setCardSortCriteria: (crit) => { if (Array.isArray(crit) && crit.length === 3) currentConfig.cardSortCriteria = crit; else console.warn("setCardSortCriteria inválido"); },
      getFieldConfigForLane: (t, lv, f) => {
        const laneCfg = currentConfig.laneConfigs?.[t]?.[String(lv)]?.[f] || {};
        if (!laneCfg.refListFieldConfigs || typeof laneCfg.refListFieldConfigs !== 'object') {
            laneCfg.refListFieldConfigs = {};
        }
        return { ...FIELD_DEFAULTS_INTERNAL, ...laneCfg };
      },
      updateFieldConfigForLane: (t, lv, f, cfg) => { if (!t||lv==null||!f) return; currentConfig.laneConfigs[t] = currentConfig.laneConfigs[t] || {}; currentConfig.laneConfigs[t][String(lv)] = currentConfig.laneConfigs[t][String(lv)] || {}; currentConfig.laneConfigs[t][String(lv)][f] = { ...FIELD_DEFAULTS_INTERNAL, ...currentConfig.laneConfigs[t][String(lv)][f], ...cfg }; },
      getDefaults: () => ({ ...FIELD_DEFAULTS_INTERNAL }),
      getKanbanDefaults: () => JSON.parse(JSON.stringify(KANBAN_DEFAULTS_INTERNAL)),
      getAllRules: () => JSON.parse(JSON.stringify(currentConfig.rules)),
      getRulesForLane: laneValue => (currentConfig.rules[String(laneValue)] || []).map(r => ({ ...r })),
      setAllRules: rules => { currentConfig.rules = JSON.parse(JSON.stringify(rules)); },
    };
  })();

  window.ConfigUIBuilder = (function () {
    let drawerEl, laneSelectEl, fieldsTableContainerEl, saveBtnEl, cancelBtnEl, closeBtnEl, replicateBtnEl, onSaveCallback, currentGristTableMeta, currentKanbanLanes, allGristTablesList, configSortState = { columnKey: 'iniOrder', direction: 'asc' }, tabBtnFields, tabBtnGeneral, tabBtnVisual, tabBtnRules, tabContentFields, tabContentGeneral, tabContentVisual, tabContentRules, definingColumnMapSelectEl, wipLimitsTableContainerEl, restrictAdjacentMoveCbEl, cardSortCriteriaContainerEl, centerColumnsCb, colWidthPercentInput, colMinWidthInput, colMaxWidthInput, colColorInput, cardColorInput, cardShadowInput, rulesConfigAreaEl,
    cfgBackgroundTypeSelect, cfgSolidColorSettingsDiv, cfgSolidBgColorInput,
    cfgGradientSettingsDiv, cfgGradientColor1Input, cfgGradientColor2Input,
    cfgGradientDirectionContainerDiv, cfgGradientDirectionSelect,
    cfgDrawerFontColorInput, cfgCardTitleFontColorInput, cfgCardFieldsFontColorInput;

    const RULE_OPERATORS = [
        { value: '==', key: 'op_equals' }, { value: '!=', key: 'op_not_equals' },
        { value: '>', key: 'op_greater_than' }, { value: '<', key: 'op_less_than' },
        { value: '>=', key: 'op_greater_than_equal' }, { value: '<=', key: 'op_less_than_equal' },
        { value: 'contains', key: 'op_contains' }, { value: 'not_contains', key: 'op_not_contains' },
        { value: 'is_empty', key: 'op_is_empty' }, { value: 'is_not_empty', key: 'op_is_not_empty' }
    ];
    
    function init(options) {
        drawerEl = options.drawerEl;
        laneSelectEl = drawerEl.querySelector('#kanban-lane-select'); fieldsTableContainerEl = drawerEl.querySelector('#cfg-fields-table-container'); replicateBtnEl = drawerEl.querySelector('#cfg-replicate'); definingColumnMapSelectEl = drawerEl.querySelector('#kanban-defining-column-map-select'); wipLimitsTableContainerEl = drawerEl.querySelector('#wip-limits-table-container'); restrictAdjacentMoveCbEl = drawerEl.querySelector('#cfg-restrict-adjacent-move'); cardSortCriteriaContainerEl = drawerEl.querySelector('#card-sort-criteria-container'); tabBtnFields = drawerEl.querySelector('#cfg-tab-btn-fields'); tabBtnGeneral = drawerEl.querySelector('#cfg-tab-btn-general'); tabBtnVisual = drawerEl.querySelector('#cfg-tab-btn-visual'); tabBtnRules = drawerEl.querySelector('#cfg-tab-btn-rules'); tabContentFields = drawerEl.querySelector('#cfg-tab-content-fields'); tabContentGeneral = drawerEl.querySelector('#cfg-tab-content-general'); tabContentVisual = drawerEl.querySelector('#cfg-tab-content-visual'); tabContentRules = drawerEl.querySelector('#cfg-tab-content-rules'); rulesConfigAreaEl = drawerEl.querySelector('#rules-config-area'); centerColumnsCb = drawerEl.querySelector('#cfg-center-columns'); colWidthPercentInput = drawerEl.querySelector('#cfg-col-width-percent'); colMinWidthInput = drawerEl.querySelector('#cfg-col-min-width'); colMaxWidthInput = drawerEl.querySelector('#cfg-col-max-width'); colColorInput = drawerEl.querySelector('#cfg-col-color'); cardColorInput = drawerEl.querySelector('#cfg-card-color'); cardShadowInput = drawerEl.querySelector('#cfg-card-shadow');
        cfgBackgroundTypeSelect = drawerEl.querySelector('#cfg-background-type');
        cfgSolidColorSettingsDiv = drawerEl.querySelector('#cfg-solid-color-settings');
        cfgSolidBgColorInput = drawerEl.querySelector('#cfg-solid-background-color');
        cfgGradientSettingsDiv = drawerEl.querySelector('#cfg-gradient-settings');
        cfgGradientColor1Input = drawerEl.querySelector('#cfg-gradient-color1');
        cfgGradientColor2Input = drawerEl.querySelector('#cfg-gradient-color2');
        cfgGradientDirectionContainerDiv = drawerEl.querySelector('#cfg-gradient-direction-container');
        cfgGradientDirectionSelect = drawerEl.querySelector('#cfg-gradient-direction');
        cfgDrawerFontColorInput = drawerEl.querySelector('#cfg-drawer-font-color');
        cfgCardTitleFontColorInput = drawerEl.querySelector('#cfg-card-title-font-color');
        cfgCardFieldsFontColorInput = drawerEl.querySelector('#cfg-card-fields-font-color');
        saveBtnEl = options.saveBtnEl; cancelBtnEl = options.cancelBtnEl; closeBtnEl = options.closeBtnEl; onSaveCallback = options.onSave; if (replicateBtnEl) replicateBtnEl.onclick = handleReplicateSelection; if (tabBtnFields) tabBtnFields.onclick = e => { e.preventDefault(); switchTab('fields'); }; if (tabBtnGeneral) tabBtnGeneral.onclick = e => { e.preventDefault(); switchTab('general'); }; if (tabBtnVisual) tabBtnVisual.onclick = e => { e.preventDefault(); switchTab('visual'); }; if (tabBtnRules) tabBtnRules.onclick = e => { e.preventDefault(); switchTab('rules'); }; if (saveBtnEl) saveBtnEl.onclick = handleSaveConfiguration; if (cancelBtnEl) cancelBtnEl.onclick = closeDrawer; if (closeBtnEl) closeBtnEl.onclick = closeDrawer; if (laneSelectEl) laneSelectEl.onchange = handleLaneChanged;

        if (cfgBackgroundTypeSelect) {
            cfgBackgroundTypeSelect.onchange = function() {
                const type = this.value;
                cfgSolidColorSettingsDiv.style.display = (type === 'solid') ? 'block' : 'none';
                cfgGradientSettingsDiv.style.display = (type === 'linear' || type === 'radial') ? 'block' : 'none';
                cfgGradientDirectionContainerDiv.style.display = (type === 'linear') ? 'block' : 'none';
            };
        }
    }
    
    function handleLaneChanged() {
        const selectedLaneValue = laneSelectEl.value;
        configSortState = { columnKey: 'iniOrder', direction: 'asc' }; // Reset sort state for fields table
        if (typeof selectedLaneValue !== 'undefined' && selectedLaneValue !== "") {
            if (fieldsTableContainerEl) {
                fieldsTableContainerEl.style.display = 'block';
                populateFieldsTableForLane(selectedLaneValue, true);
            } else {
                console.error("CUIB.handleLaneChanged: fieldsTableContainerEl não encontrado.");
            }
        } else {
            if (fieldsTableContainerEl) {
                fieldsTableContainerEl.style.display = 'none';
                fieldsTableContainerEl.innerHTML = '';
            }
        }
    }
    function switchTab(tabName) { [tabBtnFields, tabBtnGeneral, tabBtnVisual, tabBtnRules].forEach(btn => btn?.classList.remove('active')); [tabContentFields, tabContentGeneral, tabContentVisual, tabContentRules].forEach(content => content?.classList.remove('active')); if (tabName === 'fields') { tabBtnFields.classList.add('active'); tabContentFields.classList.add('active'); } else if (tabName === 'general') { tabBtnGeneral.classList.add('active'); tabContentGeneral.classList.add('active'); } else if (tabName === 'visual') { tabBtnVisual.classList.add('active'); tabContentVisual.classList.add('active'); } else if (tabName === 'rules') { tabBtnRules.classList.add('active'); tabContentRules.classList.add('active'); } }

    function populateAndOpen(gristTableMetaIn, processedKanbanLanesIn, allTablesListIn) {
        currentGristTableMeta = gristTableMetaIn; currentKanbanLanes = processedKanbanLanesIn; allGristTablesList = allTablesListIn; if (fieldsTableContainerEl) { fieldsTableContainerEl.style.display = 'none'; fieldsTableContainerEl.innerHTML = ''; } configSortState = { columnKey: 'iniOrder', direction: 'asc' }; const laneSelectorDiv = drawerEl.querySelector('#kanban-lane-selector-div'); if (currentKanbanLanes && currentKanbanLanes.length > 0) { if (laneSelectorDiv) laneSelectorDiv.style.display = 'block'; if (laneSelectEl) laneSelectEl.innerHTML = `<option value="">${_('select_lane')}</option>`; currentKanbanLanes.forEach(lane => { if (lane.value === "_UNMATCHED_LANE_" || lane.isUnmatched) return; const option = document.createElement('option'); option.value = lane.value; option.textContent = lane.value || "[Vazio]"; if (laneSelectEl) laneSelectEl.appendChild(option); }); if (laneSelectEl) laneSelectEl.value = ""; } else { if (laneSelectorDiv) laneSelectorDiv.style.display = 'block'; if (laneSelectEl) laneSelectEl.innerHTML = `<option value="">${_('no_lane_defined')}</option>`; } if (definingColumnMapSelectEl) definingColumnMapSelectEl.innerHTML = `<option value="">${_('select_column')}</option>`; if (currentGristTableMeta && currentGristTableMeta.columns) { currentGristTableMeta.columns.forEach(col => { if (['Choice', 'ChoiceList', 'Text', 'Any', 'Date', 'DateTime', 'Numeric', 'Int', 'Ref', 'RefList'].includes(col.type.split(':')[0])) { const option = document.createElement('option'); option.value = col.id; option.textContent = `${col.label} (${col.id}) - ${_('column_type')} ${col.type}`; if (definingColumnMapSelectEl) definingColumnMapSelectEl.appendChild(option); } }); } const currentDefiningCol = WidgetConfigManager.getKanbanDefiningColumn(); if (currentDefiningCol && definingColumnMapSelectEl) { definingColumnMapSelectEl.value = currentDefiningCol; } else if (definingColumnMapSelectEl) { definingColumnMapSelectEl.value = ""; } populateCardSortCriteriaUI(); populateWipLimitsTable(); if (restrictAdjacentMoveCbEl) { restrictAdjacentMoveCbEl.checked = WidgetConfigManager.getRestrictAdjacentMove(); }
        const vis = WidgetConfigManager.getVisualConfig();
        const visDefaults = WidgetConfigManager.getKanbanDefaults().visual;
        centerColumnsCb.checked = vis.centerColumns;
        colWidthPercentInput.value = vis.columnWidthPercent;
        colMinWidthInput.value = vis.columnMinWidth;
        colMaxWidthInput.value = vis.columnMaxWidth;
        colColorInput.value = vis.columnColor || visDefaults.columnColor;
        cardColorInput.value = vis.cardColor || visDefaults.cardColor;
        cardShadowInput.checked = Boolean(vis.cardShadow);
        cfgDrawerFontColorInput.value = vis.drawerFontColor || visDefaults.drawerFontColor;
        cfgCardTitleFontColorInput.value = vis.cardTitleFontColor || visDefaults.cardTitleFontColor;
        cfgCardFieldsFontColorInput.value = vis.cardFieldsFontColor || visDefaults.cardFieldsFontColor;
        cfgBackgroundTypeSelect.value = vis.backgroundType || visDefaults.backgroundType;
        cfgSolidBgColorInput.value = vis.solidBackgroundColor || visDefaults.solidBackgroundColor;
        cfgGradientColor1Input.value = vis.gradientColor1 || visDefaults.gradientColor1;
        cfgGradientColor2Input.value = vis.gradientColor2 || visDefaults.gradientColor2;
        cfgGradientDirectionSelect.value = vis.gradientDirection || visDefaults.gradientDirection;
        if (cfgBackgroundTypeSelect.onchange) cfgBackgroundTypeSelect.onchange();
        populateRulesUI(); switchTab('fields'); if (drawerEl) drawerEl.classList.add('visible'); else console.error("CUIB.populateAndOpen: drawerEl é null!");
    }

    function populateRulesUI() { if (!rulesConfigAreaEl || !currentKanbanLanes || !currentGristTableMeta) { if (rulesConfigAreaEl) rulesConfigAreaEl.innerHTML = "<p><i>Lanes ou metadados da tabela principal não disponíveis.</i></p>"; return; } rulesConfigAreaEl.innerHTML = ''; const allRules = WidgetConfigManager.getAllRules(); currentKanbanLanes.filter(lane => !lane.isUnmatched).forEach(lane => { const laneSection = document.createElement('div'); laneSection.className = 'rules-lane-section'; laneSection.dataset.laneValue = lane.value; const title = document.createElement('h4'); title.textContent = `${_('rules_for_lane')}"${lane.value || '[Vazio]'}"`; laneSection.appendChild(title); const rulesContainer = document.createElement('div'); rulesContainer.className = 'rules-items-container'; laneSection.appendChild(rulesContainer); const existingRulesForLane = allRules[String(lane.value)] || []; existingRulesForLane.forEach(ruleData => { rulesContainer.appendChild(createRuleItemElement(ruleData, String(lane.value))); }); const addRuleBtn = document.createElement('button'); addRuleBtn.textContent = _('add_rule'); addRuleBtn.className = 'add-rule-btn'; addRuleBtn.type = 'button'; addRuleBtn.onclick = () => { rulesContainer.appendChild(createRuleItemElement({}, String(lane.value))); }; laneSection.appendChild(addRuleBtn); rulesConfigAreaEl.appendChild(laneSection); }); }
        function createRuleItemElement(ruleData = {}, laneValue) {
        const ruleItemDiv = document.createElement('div');
        ruleItemDiv.className = 'rule-item';
        ruleItemDiv.dataset.ruleId = ruleData.id || `temp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const headerDiv = document.createElement('div');
        headerDiv.className = 'rule-item-header';
        const typeSelect = document.createElement('select');
        typeSelect.className = 'rule-type';
        [{value: 'allow', text: _('rule_type_allow')}, {value: 'create', text: _('rule_type_create')}, {value: 'move', text: _('rule_type_move')}].forEach(opt => { typeSelect.add(new Option(opt.text, opt.value)); });
        typeSelect.value = ruleData.type || 'allow';
        headerDiv.appendChild(typeSelect);
        const removeRuleBtn = document.createElement('button');
        removeRuleBtn.textContent = _('remove_rule');
        removeRuleBtn.className = 'rule-remove-btn';
        removeRuleBtn.type = 'button';
        removeRuleBtn.onclick = () => ruleItemDiv.remove();
        headerDiv.appendChild(removeRuleBtn);
        ruleItemDiv.appendChild(headerDiv);
        const paramsDiv = document.createElement('div');
        paramsDiv.className = 'rule-params';
        ruleItemDiv.appendChild(paramsDiv);

        const renderParamsForType = async (selectedType) => {
            paramsDiv.innerHTML = '';
            if (selectedType === 'allow') {
                const conditionDiv = document.createElement('div');
                conditionDiv.style.display = 'flex';
                conditionDiv.style.gap = '8px';
                conditionDiv.style.alignItems = 'center';
                const fieldSelect = document.createElement('select');
                fieldSelect.className = 'rule-param-field';
                fieldSelect.add(new Option(_('field_current_table'), ''));
                currentGristTableMeta.columns.forEach(col => fieldSelect.add(new Option(`${col.label || col.id} (${col.type.split(':')[0]})`, col.id)));
                if (ruleData.fieldId) fieldSelect.value = ruleData.fieldId;
                conditionDiv.appendChild(fieldSelect);
                const operatorSelect = document.createElement('select');
                operatorSelect.className = 'rule-param-operator';
                operatorSelect.add(new Option(_('operator'), ''));
                RULE_OPERATORS.forEach(op => operatorSelect.add(new Option(_(op.key), op.value)));
                if (ruleData.operator) operatorSelect.value = ruleData.operator;
                conditionDiv.appendChild(operatorSelect);
                const valueInput = document.createElement('input');
                valueInput.type = 'text';
                valueInput.className = 'rule-param-value';
                valueInput.placeholder = _('rule_value_placeholder');
                valueInput.value = ruleData.value || '';
                conditionDiv.appendChild(valueInput);
                paramsDiv.appendChild(conditionDiv);
            } else if (selectedType === 'create') {
                const actionDiv = document.createElement('div');
                actionDiv.style.display = 'flex';
                actionDiv.style.flexDirection = 'column';
                actionDiv.style.gap = '10px';
                const createRow = (labelText, element) => {
                    const rowDiv = document.createElement('div');
                    rowDiv.style.display = 'flex';
                    rowDiv.style.alignItems = 'center';
                    rowDiv.style.gap = '5px';
                    const label = document.createElement('label');
                    label.textContent = labelText;
                    label.style.minWidth = '220px';
                    rowDiv.append(label, element);
                    return rowDiv;
                };
                const targetTableSelect = document.createElement('select');
                targetTableSelect.className = 'rule-param-target-table';
                targetTableSelect.style.flexGrow = '1';
                targetTableSelect.add(new Option(_('target_table'), ''));
                allGristTablesList.forEach(tbl => {
                    if (tbl.id !== currentGristTableMeta.nameId) {
                        targetTableSelect.add(new Option(tbl.name || tbl.id, tbl.id));
                    }
                });
                actionDiv.appendChild(createRow('Tabela de Destino:', targetTableSelect));
                const relationFieldSelect = document.createElement('select');
                relationFieldSelect.className = 'rule-param-relation-field';
                relationFieldSelect.style.flexGrow = '1';
                relationFieldSelect.add(new Option(_('placeholder_relation_field'), ''));
                actionDiv.appendChild(createRow(_('relation_field'), relationFieldSelect));
                const targetLaneColSelect = document.createElement('select');
                targetLaneColSelect.className = 'rule-param-target-lane-column';
                targetLaneColSelect.style.flexGrow = '1';
                targetLaneColSelect.add(new Option(_('placeholder_status_column'), ''));
                actionDiv.appendChild(createRow(_('status_column_dest'), targetLaneColSelect));
                const initialLaneValueSelect = document.createElement('select');
                initialLaneValueSelect.className = 'rule-param-initial-lane-value';
                initialLaneValueSelect.style.flexGrow = '1';
                initialLaneValueSelect.add(new Option(_('placeholder_initial_lane'), ''));
                actionDiv.appendChild(createRow(_('initial_lane'), initialLaneValueSelect));
                const populateSelectWithOptions = async (selectElement, getOptionsAsync, currentValue, placeholder = null) => {
                    if (placeholder === null) placeholder = _('select_option');
                    const originalValue = selectElement.value;
                    selectElement.innerHTML = `<option value="">${placeholder}</option>`;
                    try {
                        const options = await getOptionsAsync();
                        if (!options || options.length === 0) {
                            return;
                        }
                        options.forEach(opt => selectElement.add(new Option(opt.text, opt.value)));
                        if (currentValue && Array.from(selectElement.options).some(opt => opt.value === currentValue)) {
                            selectElement.value = currentValue;
                        } else if (Array.from(selectElement.options).some(opt => opt.value === originalValue)) {
                            selectElement.value = originalValue;
                        }
                    } catch (e) {
                        console.error("Erro em populateSelectWithOptions:", e);
                    }
                };
                targetTableSelect.onchange = async () => {
                    const selectedTargetTableId = targetTableSelect.value;
                    await populateSelectWithOptions(relationFieldSelect, async () => {
                        if (!selectedTargetTableId) return [];
                        const schema = await GristDataManager.getTableSchema(selectedTargetTableId);
                        return schema.columns.map(c => ({
                            text: `${c.label || c.id} (${c.type.split(':')[0]})`,
                            value: c.id
                        }));
                    }, ruleData.relationFieldIdInTarget, _('placeholder_relation_field'));
                    await populateSelectWithOptions(targetLaneColSelect, async () => {
                        if (!selectedTargetTableId) return [];
                        const schema = await GristDataManager.getTableSchema(selectedTargetTableId);
                        return schema.columns.filter(c => c.type === 'Choice' || c.type === 'ChoiceList').map(c => ({
                            text: `${c.label || c.id}`,
                            value: c.id
                        }));
                    }, ruleData.targetColumnIdForLane, _('placeholder_status_column'));
                    initialLaneValueSelect.innerHTML = `<option value="">${_('placeholder_initial_lane_short')}</option>`;
                    if (targetLaneColSelect.value) {
                        const schema = await GristDataManager.getTableSchema(selectedTargetTableId);
                        const choiceCol = schema.columns.find(c => c.id === targetLaneColSelect.value);
                        if (choiceCol && choiceCol.choices) {
                            await populateSelectWithOptions(initialLaneValueSelect, async () => choiceCol.choices.map(ch => ({
                                text: ch,
                                value: ch
                            })), ruleData.initialLaneValue, _('placeholder_initial_lane_short'));
                        }
                    }
                };
                targetLaneColSelect.onchange = async () => {
                    const selectedTargetTableId = targetTableSelect.value;
                    const selectedLaneColumnId = targetLaneColSelect.value;
                    if (selectedTargetTableId && selectedLaneColumnId) {
                        const schema = await GristDataManager.getTableSchema(selectedTargetTableId);
                        const choiceCol = schema.columns.find(c => c.id === selectedLaneColumnId);
                        if (choiceCol && choiceCol.choices) {
                            await populateSelectWithOptions(initialLaneValueSelect, async () => choiceCol.choices.map(ch => ({
                                text: ch,
                                value: ch
                            })), ruleData.initialLaneValue, _('placeholder_initial_lane_short'));
                        } else {
                            initialLaneValueSelect.innerHTML = `<option value="">${_('placeholder_no_options')}</option>`;
                        }
                    } else {
                        initialLaneValueSelect.innerHTML = `<option value="">${_('placeholder_select_lane_column')}</option>`;
                    }
                };
                if (ruleData.targetTableId) {
                    targetTableSelect.value = ruleData.targetTableId;
                    await targetTableSelect.onchange();
                }
                paramsDiv.appendChild(actionDiv);
            } else if (selectedType === 'move') {
                const moveParamsDiv = document.createElement('div');
                moveParamsDiv.style.display = 'flex';
                moveParamsDiv.style.flexDirection = 'column';
                moveParamsDiv.style.gap = '10px';
                const conditionTitle = document.createElement('strong');
                conditionTitle.textContent = _('condition_if');
                moveParamsDiv.appendChild(conditionTitle);
                const conditionLineDiv = document.createElement('div');
                conditionLineDiv.style.display = 'flex';
                conditionLineDiv.style.gap = '8px';
                conditionLineDiv.style.alignItems = 'center';
                const fieldSelectMove = document.createElement('select');
                fieldSelectMove.className = 'rule-param-field-move';
                fieldSelectMove.add(new Option(_('field_current_table'), ''));
                currentGristTableMeta.columns.forEach(col => fieldSelectMove.add(new Option(`${col.label || col.id} (${col.type.split(':')[0]})`, col.id)));
                if (ruleData.fieldId) fieldSelectMove.value = ruleData.fieldId;
                conditionLineDiv.appendChild(fieldSelectMove);
                const operatorSelectMove = document.createElement('select');
                operatorSelectMove.className = 'rule-param-operator-move';
                operatorSelectMove.add(new Option(_('operator'), ''));
                RULE_OPERATORS.forEach(op => operatorSelectMove.add(new Option(_(op.key), op.value)));
                if (ruleData.operator) operatorSelectMove.value = ruleData.operator;
                conditionLineDiv.appendChild(operatorSelectMove);
                const valueInputMove = document.createElement('input');
                valueInputMove.type = 'text';
                valueInputMove.className = 'rule-param-value-move';
                valueInputMove.placeholder = _('rule_value_placeholder');
                valueInputMove.value = ruleData.value || '';
                conditionLineDiv.appendChild(valueInputMove);
                moveParamsDiv.appendChild(conditionLineDiv);
                const actionTitle = document.createElement('strong');
                actionTitle.textContent = _('action_move');
                actionTitle.style.marginTop = '10px';
                moveParamsDiv.appendChild(actionTitle);
                const targetLaneSelect = document.createElement('select');
                targetLaneSelect.className = 'rule-param-target-lane';
                targetLaneSelect.add(new Option(_('select_target_lane'), ''));
                currentKanbanLanes.filter(l => !l.isUnmatched && l.value !== laneValue).forEach(kLane => {
                    targetLaneSelect.add(new Option(kLane.value || '[Vazio]', kLane.value));
                });
                if (ruleData.targetLaneValue) targetLaneSelect.value = ruleData.targetLaneValue;
                moveParamsDiv.appendChild(targetLaneSelect);
                paramsDiv.appendChild(moveParamsDiv);
            }
        };
        typeSelect.onchange = () => renderParamsForType(typeSelect.value);
        renderParamsForType(typeSelect.value);
        return ruleItemDiv;
    }
    function populateWipLimitsTable() {
      if (!wipLimitsTableContainerEl || !currentKanbanLanes || currentKanbanLanes.length === 0) { if (wipLimitsTableContainerEl) { wipLimitsTableContainerEl.innerHTML = `<p><i>${_('no_lanes_wip')}</i></p>`; } return; }
      wipLimitsTableContainerEl.innerHTML = '';
      const table = document.createElement('table'); table.className = 'wip-limit-table';
      const thead = table.createTHead(); const headerRow = thead.insertRow();
      ["Lane", _('max_visible'), _('max_allowed')].forEach(text => { const th = document.createElement('th'); th.textContent = text; headerRow.appendChild(th); });
      const tbody = table.createTBody();
      currentKanbanLanes.filter(lane => !lane.isUnmatched).forEach(lane => {
        const row = tbody.insertRow(); row.insertCell().textContent = lane.value || "[Vazio]";
        const currentLimits = WidgetConfigManager.getLaneWipLimit(lane.value);
        let cellVisible = row.insertCell(); let inputVisible = document.createElement('input'); inputVisible.type = 'number'; inputVisible.min = '0'; inputVisible.placeholder = _('all'); inputVisible.dataset.laneValue = lane.value; inputVisible.dataset.limitType = 'maxVisible'; inputVisible.value = currentLimits.maxVisible > 0 ? currentLimits.maxVisible : ''; cellVisible.appendChild(inputVisible);
        let cellAllowed = row.insertCell(); let inputAllowed = document.createElement('input'); inputAllowed.type = 'number'; inputAllowed.min = '0'; inputAllowed.placeholder = _('no_limit'); inputAllowed.dataset.laneValue = lane.value; inputAllowed.dataset.limitType = 'maxAllowed'; inputAllowed.value = currentLimits.maxAllowed > 0 ? currentLimits.maxAllowed : ''; cellAllowed.appendChild(inputAllowed);
      });
      wipLimitsTableContainerEl.appendChild(table);
    }
    function populateCardSortCriteriaUI() {
      if (!cardSortCriteriaContainerEl || !currentGristTableMeta || !currentGristTableMeta.columns) { if (cardSortCriteriaContainerEl) { cardSortCriteriaContainerEl.innerHTML = `<p><i>${_('load_metadata')}</i></p>`; } return; }
      cardSortCriteriaContainerEl.innerHTML = '';
      const currentSortCriteria = WidgetConfigManager.getCardSortCriteria();
      for (let i = 0; i < 3; i++) {
        const criterionDiv = document.createElement('div'); criterionDiv.className = 'sort-criterion';
        const label = document.createElement('label'); label.textContent = i === 0 ? _('sort_by') : (i === 1 ? _('then_by') : _('and_then_by')); criterionDiv.appendChild(label);
        const colSelect = document.createElement('select'); colSelect.id = `sort-col-${i}`; colSelect.innerHTML = `<option value="">${_('none')}</option>`;
        currentGristTableMeta.columns.forEach(col => colSelect.appendChild(Object.assign(document.createElement('option'), { value: col.id, textContent: `${col.label} (${col.type.split(':')[0]})` })));
        colSelect.value = currentSortCriteria[i]?.columnId || ''; criterionDiv.appendChild(colSelect);
        const dirSelect = document.createElement('select'); dirSelect.id = `sort-dir-${i}`; dirSelect.className = 'direction';
        [{value: 'asc', text: _('asc')}, {value: 'desc', text: _('desc')}].forEach(dir => dirSelect.appendChild(Object.assign(document.createElement('option'),{ value: dir.value, textContent: dir.text })));
        dirSelect.value = currentSortCriteria[i]?.direction || 'asc'; criterionDiv.appendChild(dirSelect);
        const typeSelect = document.createElement('select'); typeSelect.id = `sort-type-${i}`; typeSelect.title = _('sort_type_tooltip');
        [{value: '', text: '-- Normal --'}, {value: 'priority', text: _('priority')}, {value: 'dueDate', text: _('due_date')}].forEach(tp => { const opt = document.createElement('option'); opt.value = tp.value; opt.textContent = tp.text; typeSelect.appendChild(opt); });
        typeSelect.value = currentSortCriteria[i]?.displayType || ''; criterionDiv.appendChild(typeSelect);
        cardSortCriteriaContainerEl.appendChild(criterionDiv);
      }
    }
    function getColumnIndex(dataKey) { const headerMap = { 'iniOrder': 1, 'labelName': 2, 'useFormatting': 3, 'card': 4, 'cardPosition': 5, 'showLabel': 6, 'visible': 7, 'editable': 8, 'position': 9 }; return headerMap[dataKey] || -1; }
    function createSelectAllCheckbox(columnKey) {
      const selectAllCb = document.createElement('input'); selectAllCb.type = 'checkbox'; selectAllCb.title = `Marcar/Desmarcar todos para ${columnKey}`;
      selectAllCb.onclick = function (e) {
        e.stopPropagation(); const isChecked = e.target.checked; const tableBody = fieldsTableContainerEl.querySelector('tbody'); const colIdx = getColumnIndex(columnKey); if (!tableBody || colIdx < 0) return;
        tableBody.querySelectorAll(`tr td:nth-child(${colIdx}) input[type="checkbox"]`).forEach(cb => { cb.checked = isChecked; });
      };
      return selectAllCb;
    }
    function updateSelectAllCheckboxState(headerCheckbox, columnKey) {
      if (!headerCheckbox) return;
      const tableBody = fieldsTableContainerEl.querySelector('tbody'); const colIdx = getColumnIndex(columnKey);
      if (!tableBody || !tableBody.hasChildNodes() || colIdx < 0) { if (headerCheckbox) { headerCheckbox.checked = false; headerCheckbox.indeterminate = false; } return; }
      const checkboxes = tableBody.querySelectorAll(`tr td:nth-child(${colIdx}) input[type="checkbox"]`);
      if (checkboxes.length === 0) { if (headerCheckbox) { headerCheckbox.style.display = 'none'; headerCheckbox.checked = false; headerCheckbox.indeterminate = false; } return; } else { if (headerCheckbox) headerCheckbox.style.display = ''; }
      const total = checkboxes.length; const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
      if (!headerCheckbox) return;
      if (checkedCount === 0) { headerCheckbox.checked = false; headerCheckbox.indeterminate = false; } else if (checkedCount === total) { headerCheckbox.checked = true; headerCheckbox.indeterminate = false; } else { headerCheckbox.checked = false; headerCheckbox.indeterminate = true; }
    }

    async function populateRefListFieldsConfigTable(container, parentFieldData, laneValue) {
        if (!parentFieldData.referencedTableId) {
            container.innerHTML = `<em>${_('no_ref_table')}</em>`;
            return;
        }
        const refTableSchema = await GristDataManager.getTableSchema(parentFieldData.referencedTableId);
        container.innerHTML = `<h5>${_('linked_columns_config')} (${refTableSchema.tableId})</h5>`;
        const table = document.createElement('table');
        const thead = table.createTHead();
        const headerRow = thead.insertRow();
        ["Campo Vinculado", _('on_card'), _('card_position'), _('visible_drawer'), _('editable_drawer'), _('drawer_position')].forEach(txt => {
            const th = document.createElement('th');
            th.textContent = txt;
            headerRow.appendChild(th);
        });
        const tbody = table.createTBody();
        const parentFieldConfig = WidgetConfigManager.getFieldConfigForLane(currentGristTableMeta.nameId, laneValue, parentFieldData.id);

        refTableSchema.columns.filter(c => c.id !== 'manualSort').forEach(col => {
            const childConfig = parentFieldConfig.refListFieldConfigs?.[col.id] || {};
            const row = tbody.insertRow();
            row.dataset.refFieldId = col.id;

            row.insertCell().textContent = `${col.label} (${col.id})`;
            
            const createCb = (checked) => { const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!checked; return cb; };
            const createNum = (value) => { const num = document.createElement('input'); num.type = 'number'; num.min = '0'; num.value = value || 0; return num; };

            row.insertCell().appendChild(createCb(childConfig.card)).dataset.key = 'card';
            row.insertCell().appendChild(createNum(childConfig.cardPosition)).dataset.key = 'cardPosition';
            row.insertCell().appendChild(createCb(childConfig.visible === undefined ? true : childConfig.visible)).dataset.key = 'visible';
            row.insertCell().appendChild(createCb(childConfig.editable === undefined ? true : childConfig.editable)).dataset.key = 'editable';
            row.insertCell().appendChild(createNum(childConfig.position)).dataset.key = 'position';
        });
        container.appendChild(table);
    }
    
    function populateFieldsTableForLane(laneValue, fromSavedDataOnly = false) {
      if (!currentGristTableMeta || !fieldsTableContainerEl) { console.warn("populateFieldsTableForLane: Metadados da tabela ou container da tabela de campos não disponíveis."); if (fieldsTableContainerEl) fieldsTableContainerEl.innerHTML = `<p><i>${_('error_loading_fields')}</i></p>`; return; }
      const tableId = currentGristTableMeta.nameId;
      const kanbanStatusDefiningColumnId = WidgetConfigManager.getKanbanDefiningColumn();
      const defaults = WidgetConfigManager.getDefaults();
      let fieldsData = currentGristTableMeta.columns.map((col, index) => {
          let currentDataFromUI = {};
          if (!fromSavedDataOnly && fieldsTableContainerEl.querySelector('tbody')) {
            const rowInUI = fieldsTableContainerEl.querySelector(`tbody tr[data-field-id="${col.id}"]`);
            if (rowInUI) {
              try {
                currentDataFromUI.useFormatting = rowInUI.cells[getColumnIndex('useFormatting') - 1].querySelector('input').checked;
                currentDataFromUI.card = rowInUI.cells[getColumnIndex('card') - 1].querySelector('input').checked;
                currentDataFromUI.cardPosition = parseInt(rowInUI.cells[getColumnIndex('cardPosition') - 1].querySelector('input').value, 10);
                currentDataFromUI.showLabel = rowInUI.cells[getColumnIndex('showLabel') - 1].querySelector('input').checked;
                currentDataFromUI.visible = rowInUI.cells[getColumnIndex('visible') - 1].querySelector('input').checked;
                currentDataFromUI.editable = rowInUI.cells[getColumnIndex('editable') - 1].querySelector('input').checked;
                currentDataFromUI.position = parseInt(rowInUI.cells[getColumnIndex('position') - 1].querySelector('input').value, 10);
              } catch (e) { console.warn("Erro ao ler UI para campo (populateFieldsTableForLane):", col.id, e); }
            }
          }
          const savedConfig = WidgetConfigManager.getFieldConfigForLane(tableId, laneValue, col.id);
          return {
            id: col.id, label: col.label, type: col.type, referencedTableId: col.referencedTableId,
            config: {
              useFormatting: currentDataFromUI.hasOwnProperty('useFormatting') && !fromSavedDataOnly ? currentDataFromUI.useFormatting : (savedConfig.useFormatting !== undefined ? savedConfig.useFormatting : defaults.useFormatting),
              card: currentDataFromUI.hasOwnProperty('card') && !fromSavedDataOnly ? currentDataFromUI.card : savedConfig.card,
              cardPosition: currentDataFromUI.hasOwnProperty('cardPosition') && !isNaN(currentDataFromUI.cardPosition) && !fromSavedDataOnly ? currentDataFromUI.cardPosition : (savedConfig.cardPosition !== undefined ? savedConfig.cardPosition : defaults.cardPosition),
              showLabel: currentDataFromUI.hasOwnProperty('showLabel') && !fromSavedDataOnly ? currentDataFromUI.showLabel : (savedConfig.showLabel !== undefined ? savedConfig.showLabel : defaults.showLabel),
              visible: currentDataFromUI.hasOwnProperty('visible') && !fromSavedDataOnly ? currentDataFromUI.visible : savedConfig.visible,
              editable: currentDataFromUI.hasOwnProperty('editable') && !fromSavedDataOnly ? currentDataFromUI.editable : savedConfig.editable,
              position: currentDataFromUI.hasOwnProperty('position') && !isNaN(currentDataFromUI.position) && !fromSavedDataOnly ? currentDataFromUI.position : (savedConfig.position !== undefined ? savedConfig.position : defaults.position),
              refListFieldConfigs: savedConfig.refListFieldConfigs || {},
            },
            iniOrder: index
          };
        }).filter(data => data.id !== kanbanStatusDefiningColumnId);
      fieldsTableContainerEl.innerHTML = '';
      if (typeof laneValue === 'undefined' || laneValue === "") { fieldsTableContainerEl.innerHTML = `<p><i>${_('select_lane_to_config')}</i></p>`; return; }
      const table = document.createElement('table');
      const thead = table.createTHead(); const headerRow = thead.insertRow();
      const headers = [
        { text: _('ini'), dataKey: 'iniOrder', sortable: true }, { text: _('field_name'), dataKey: 'labelName', sortable: true },
        { text: _('use_formatting'), dataKey: 'useFormatting', sortable: true, hasSelectAll: true }, { text: _('on_card'), dataKey: 'card', sortable: true, hasSelectAll: true },
        { text: _('card_position'), dataKey: 'cardPosition', sortable: true }, { text: _('show_label'), dataKey: 'showLabel', sortable: true, hasSelectAll: true },
        { text: _('visible_drawer'), dataKey: 'visible', sortable: true, hasSelectAll: true }, { text: _('editable_drawer'), dataKey: 'editable', sortable: true, hasSelectAll: true },
        { text: _('drawer_position'), dataKey: 'position', sortable: true }
      ];
      headers.forEach(headerInfo => {
        const th = document.createElement('th'); const span = document.createElement('span'); span.textContent = headerInfo.text; th.appendChild(span);
        if (headerInfo.hasSelectAll) { th.appendChild(document.createElement('br')); th.appendChild(createSelectAllCheckbox(headerInfo.dataKey)); }
        if (headerInfo.sortable) { th.style.cursor = 'pointer'; th.onclick = (e) => { if (e.target.type === 'checkbox') return; const newDirection = (configSortState.columnKey === headerInfo.dataKey && configSortState.direction === 'asc') ? 'desc' : 'asc'; configSortState = { columnKey: headerInfo.dataKey, direction: newDirection }; populateFieldsTableForLane(laneValue, false); }; if (configSortState.columnKey === headerInfo.dataKey) { span.textContent += (configSortState.direction === 'asc' ? ' ▲' : ' ▼'); } }
        headerRow.appendChild(th);
      });
      fieldsData.sort((a, b) => {
        let valA, valB; const key = configSortState.columnKey;
        if (key === 'iniOrder') { valA = a.iniOrder; valB = b.iniOrder; } else if (key === 'labelName') { valA = a.label.toLowerCase(); valB = b.label.toLowerCase(); } else if (key === 'cardPosition' || key === 'position') { valA = a.config[key]; valB = b.config[key];} else { valA = a.config[key]; valB = b.config[key];}
        if (typeof valA === 'boolean' && typeof valB === 'boolean') { valA = valA ? 1 : 0; valB = valB ? 1 : 0; }
        if (valA < valB) return configSortState.direction === 'asc' ? -1 : 1; if (valA > valB) return configSortState.direction === 'asc' ? 1 : -1; if (key !== 'iniOrder') { return a.iniOrder - b.iniOrder; } return 0;
      });
      const tbody = table.createTBody();
      fieldsData.forEach(data => {
        const row = tbody.insertRow(); row.dataset.fieldId = data.id;
        row.insertCell().textContent = data.iniOrder;
        row.insertCell().textContent = `${data.label} (${data.id})`;
        let cell, cb, numInput;
        const createCb = (flagKey, checked, colKeyForSelectAll) => { cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked; cb.dataset.flagKey = flagKey; cb.onchange = () => { updateSelectAllCheckboxState(fieldsTableContainerEl.querySelector(`th input[type="checkbox"][title*="${colKeyForSelectAll}"]`), colKeyForSelectAll); }; return cb; };
        cell = row.insertCell(); cell.appendChild(createCb('useFormatting', data.config.useFormatting, 'useFormatting'));
        cell = row.insertCell(); cell.appendChild(createCb('card', data.config.card, 'card'));
        cell = row.insertCell(); numInput = document.createElement('input'); numInput.type = 'number'; numInput.min = '0'; numInput.value = data.config.cardPosition; numInput.dataset.fieldKey = 'cardPosition'; cell.appendChild(numInput);
        cell = row.insertCell(); cell.appendChild(createCb('showLabel', data.config.showLabel, 'showLabel'));
        cell = row.insertCell(); cell.appendChild(createCb('visible', data.config.visible, 'visible'));
        cell = row.insertCell(); cell.appendChild(createCb('editable', data.config.editable, 'editable'));
        cell = row.insertCell(); numInput = document.createElement('input'); numInput.type = 'number'; numInput.min = '0'; numInput.value = data.config.position; numInput.dataset.fieldKey = 'position'; cell.appendChild(numInput);
        
        if (data.type.startsWith('RefList')) {
            const configRow = tbody.insertRow();
            configRow.dataset.refConfigRowFor = data.id;
            const configCell = configRow.insertCell();
            configCell.colSpan = headers.length;
            const configContainer = document.createElement('div');
            configContainer.className = 'reflist-config-container';
            configCell.appendChild(configContainer);
            populateRefListFieldsConfigTable(configContainer, data, laneValue);
        }
      });
      fieldsTableContainerEl.appendChild(table);
      headers.forEach(headerInfo => { if (headerInfo.hasSelectAll) { const headerCheckbox = fieldsTableContainerEl.querySelector(`th input[type="checkbox"][title*="${headerInfo.dataKey}"]`); if (headerCheckbox) updateSelectAllCheckboxState(headerCheckbox, headerInfo.dataKey); } });
    }

        function handleSaveConfiguration() {
        console.log("CUIB.handleSaveConfiguration: Iniciando salvamento..."); if (!currentGristTableMeta) { console.warn("CUIB.handleSaveConfiguration: Tentativa de salvar config sem metadados da tabela."); alert(_('error_no_metadata_save')); return; } const tableId = currentGristTableMeta.nameId; const selectedLaneValue = laneSelectEl.value; if (selectedLaneValue && fieldsTableContainerEl.querySelector('tbody')) { const tableRows = fieldsTableContainerEl.querySelectorAll('tbody tr[data-field-id]'); tableRows.forEach(row => { const fieldId = row.dataset.fieldId; if (!fieldId) return; const newFieldCfg = { useFormatting: row.cells[getColumnIndex('useFormatting') - 1].querySelector('input').checked, card: row.cells[getColumnIndex('card') - 1].querySelector('input').checked, cardPosition: parseInt(row.cells[getColumnIndex('cardPosition') - 1].querySelector('input').value, 10) || 0, showLabel: row.cells[getColumnIndex('showLabel') - 1].querySelector('input').checked, visible: row.cells[getColumnIndex('visible') - 1].querySelector('input').checked, editable: row.cells[getColumnIndex('editable') - 1].querySelector('input').checked, position: parseInt(row.cells[getColumnIndex('position') - 1].querySelector('input').value, 10) || 0, refListFieldConfigs: {} }; 
        const refConfigRow = fieldsTableContainerEl.querySelector(`tbody tr[data-ref-config-row-for="${fieldId}"]`);
        if (refConfigRow) {
            refConfigRow.querySelectorAll('tbody tr[data-ref-field-id]').forEach(refRow => {
                const refFieldId = refRow.dataset.refFieldId;
                const refFieldConfig = { fieldId: refFieldId };
                refRow.querySelectorAll('td[data-key]').forEach(cell => {
                    const input = cell.querySelector('input');
                    const key = cell.dataset.key;
                    refFieldConfig[key] = input.type === 'checkbox' ? input.checked : (parseInt(input.value, 10) || 0);
                });
                newFieldCfg.refListFieldConfigs[refFieldId] = refFieldConfig;
            });
        }
        WidgetConfigManager.updateFieldConfigForLane(tableId, selectedLaneValue, fieldId, newFieldCfg); }); }
        
        // --- INÍCIO DA LINHA NOVA ---
        const langSelect = document.getElementById('cfg-lang-select');
        if (langSelect) { WidgetConfigManager.setLanguage(langSelect.value); }
        // --- FIM DA LINHA NOVA ---

        if (definingColumnMapSelectEl) WidgetConfigManager.setKanbanDefiningColumn(definingColumnMapSelectEl.value || null); if (restrictAdjacentMoveCbEl) WidgetConfigManager.setRestrictAdjacentMove(restrictAdjacentMoveCbEl.checked); if (wipLimitsTableContainerEl) { wipLimitsTableContainerEl.querySelectorAll('input[type="number"][data-lane-value]').forEach(input => { const laneVal = input.dataset.laneValue; const limitType = input.dataset.limitType; const val = parseInt(input.value, 10) || 0; const limits = WidgetConfigManager.getLaneWipLimit(laneVal); if (limitType === 'maxVisible') limits.maxVisible = val; else if (limitType === 'maxAllowed') limits.maxAllowed = val; WidgetConfigManager.setLaneWipLimit(laneVal, limits); }); } if (cardSortCriteriaContainerEl) { const newSortCriteria = []; for (let i = 0; i < 3; i++) { newSortCriteria.push({ columnId: cardSortCriteriaContainerEl.querySelector(`#sort-col-${i}`)?.value || null, direction: cardSortCriteriaContainerEl.querySelector(`#sort-dir-${i}`)?.value || 'asc', displayType: cardSortCriteriaContainerEl.querySelector(`#sort-type-${i}`)?.value || '' }); } WidgetConfigManager.setCardSortCriteria(newSortCriteria); }
        WidgetConfigManager.setVisualConfig({ centerColumns: centerColumnsCb.checked, columnWidthPercent: Number(colWidthPercentInput.value) || 0, columnMinWidth: Number(colMinWidthInput.value) || 0, columnMaxWidth: Number(colMaxWidthInput.value) || 0, columnColor: colColorInput.value, cardColor: cardColorInput.value, cardShadow: cardShadowInput.checked, backgroundType: cfgBackgroundTypeSelect.value, solidBackgroundColor: cfgSolidBgColorInput.value, gradientColor1: cfgGradientColor1Input.value, gradientColor2: cfgGradientColor2Input.value, gradientDirection: cfgGradientDirectionSelect.value, drawerFontColor: cfgDrawerFontColorInput.value, cardTitleFontColor: cfgCardTitleFontColorInput.value, cardFieldsFontColor: cfgCardFieldsFontColorInput.value });
        const newRulesConfig = {};
        if (rulesConfigAreaEl) {
          rulesConfigAreaEl.querySelectorAll('.rules-lane-section').forEach(laneSection => {
            const laneVal = laneSection.dataset.laneValue;
            newRulesConfig[laneVal] = [];
            laneSection.querySelectorAll('.rule-item').forEach((ruleItem, ruleIndex) => {
              const ruleType = ruleItem.querySelector('.rule-type').value; const ruleId = ruleItem.dataset.ruleId || `rule_${laneVal}_${ruleIndex}`; let ruleData = { id: ruleId, type: ruleType };
              if (ruleType === 'allow') { ruleData.fieldId = ruleItem.querySelector('.rule-param-field')?.value || null; ruleData.operator = ruleItem.querySelector('.rule-param-operator')?.value || null; ruleData.value = ruleItem.querySelector('.rule-param-value')?.value || ''; }
              else if (ruleType === 'create') { ruleData.targetTableId = ruleItem.querySelector('.rule-param-target-table')?.value || null; ruleData.relationFieldIdInTarget = ruleItem.querySelector('.rule-param-relation-field')?.value || null; ruleData.targetColumnIdForLane = ruleItem.querySelector('.rule-param-target-lane-column')?.value || null; ruleData.initialLaneValue = ruleItem.querySelector('.rule-param-initial-lane-value')?.value || null; }
              else if (ruleType === 'move') { ruleData.fieldId = ruleItem.querySelector('.rule-param-field-move')?.value || null; ruleData.operator = ruleItem.querySelector('.rule-param-operator-move')?.value || null; ruleData.value = ruleItem.querySelector('.rule-param-value-move')?.value || ''; ruleData.targetLaneValue = ruleItem.querySelector('.rule-param-target-lane')?.value || null; }
              if (ruleData.type && (ruleData.fieldId || ruleData.targetTableId || ruleData.targetLaneValue)) { newRulesConfig[laneVal].push(ruleData); }
            });
          });
        }
        WidgetConfigManager.setAllRules(newRulesConfig);
        console.log("CUIB.handleSaveConfiguration: Chamando onSaveCallback..."); if (onSaveCallback) { onSaveCallback() .then(() => { console.log("CUIB.handleSaveConfiguration: onSaveCallback concluído com sucesso."); alert(_('alert_config_saved')); }) .catch(err => { console.error("CUIB.handleSaveConfiguration: ERRO no onSaveCallback:", err); alert(_('error_save_reload') + err.message); }); } else { console.error("CUIB.handleSaveConfiguration: onSaveCallback não definido!"); alert(_('error_save_function_not_found')); }
    }
    
    function handleReplicateSelection() {
        try {
            const currentLane = laneSelectEl.value;
            if (!currentLane || !fieldsTableContainerEl.querySelector('tbody tr')) {
                alert(_('error_select_source_lane'));
                return;
            }

            const sourceConfig = {};
            fieldsTableContainerEl.querySelectorAll('tbody tr[data-field-id]').forEach(row => {
                const fieldId = row.dataset.fieldId;
                if (!fieldId) return;

                const cfg = {
                    useFormatting: row.cells[getColumnIndex('useFormatting') - 1].querySelector('input').checked,
                    card: row.cells[getColumnIndex('card') - 1].querySelector('input').checked,
                    cardPosition: parseInt(row.cells[getColumnIndex('cardPosition') - 1].querySelector('input').value, 10) || 0,
                    showLabel: row.cells[getColumnIndex('showLabel') - 1].querySelector('input').checked,
                    visible: row.cells[getColumnIndex('visible') - 1].querySelector('input').checked,
                    editable: row.cells[getColumnIndex('editable') - 1].querySelector('input').checked,
                    position: parseInt(row.cells[getColumnIndex('position') - 1].querySelector('input').value, 10) || 0,
                    refListFieldConfigs: {}
                };

                const refConfigRow = fieldsTableContainerEl.querySelector(`tbody tr[data-ref-config-row-for="${fieldId}"]`);
                if (refConfigRow) {
                    refConfigRow.querySelectorAll('tbody tr[data-ref-field-id]').forEach(refRow => {
                        const refFieldId = refRow.dataset.refFieldId;
                        const refFieldConfig = { fieldId: refFieldId };
                        refRow.querySelectorAll('td[data-key]').forEach(cell => {
                            const input = cell.querySelector('input');
                            const key = cell.dataset.key;
                            refFieldConfig[key] = input.type === 'checkbox' ? input.checked : (parseInt(input.value, 10) || 0);
                        });
                        cfg.refListFieldConfigs[refFieldId] = refFieldConfig;
                    });
                }
                sourceConfig[fieldId] = cfg;
            });

            const modal = document.createElement('div');
            modal.className = 'replicate-modal';
            modal.innerHTML = ` <div class="replicate-content"> <h3>${_('replicate_title')}</h3> <label><input type="checkbox" id="rep-all" /> ${_('replicate_select_all')}</label> <div id="rep-list" style="margin:8px 0; max-height: 200px; overflow-y:auto;"></div> <button id="rep-ok">${_('replicate_ok_button')}</button> <button id="rep-cancel">${_('cancel_button')}</button> </div>`;
            document.body.appendChild(modal);

            const list = modal.querySelector('#rep-list');
            currentKanbanLanes.filter(l => !l.isUnmatched && l.value !== currentLane).forEach(lane => {
                const cbDiv = document.createElement('div');
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = lane.value;
                cb.id = `rep-cb-${lane.value}`;
                cb.className = 'rep-cb';
                const lbl = document.createElement('label');
                lbl.htmlFor = `rep-cb-${lane.value}`;
                lbl.appendChild(document.createTextNode(` ${lane.value || _('empty_value')}`));
                cbDiv.appendChild(cb);
                cbDiv.appendChild(lbl);
                list.appendChild(cbDiv);
            });

            modal.querySelector('#rep-all').onchange = e => { list.querySelectorAll('input.rep-cb').forEach(cb => cb.checked = e.target.checked); };
            modal.querySelector('#rep-cancel').onclick = () => document.body.removeChild(modal);
            modal.querySelector('#rep-ok').onclick = () => {
                const targets = Array.from(list.querySelectorAll('input.rep-cb:checked')).map(cb => cb.value);
                if (targets.length === 0) {
                    alert(_('error_no_lane_selected_replicate'));
                    return;
                }
                const tableId = currentGristTableMeta.nameId;
                targets.forEach(lv => {
                    Object.entries(sourceConfig).forEach(([fid, cfg]) => {
                        WidgetConfigManager.updateFieldConfigForLane(tableId, lv, fid, cfg);
                    });
                });
                alert(_('replicate_success').replace('{source}', currentLane).replace('{targets}', targets.join(', ')));
                document.body.removeChild(modal);
            };
        } catch (error) {
            console.error("Erro ao tentar replicar configuração:", error);
            alert(_('error_replicate_dialog'));
        }
    }
    const closeDrawer = () => { if (drawerEl) drawerEl.classList.remove('visible'); };
    
    return { init, populateAndOpen, close: closeDrawer };
  })();

  /*****************************************************************
   * 2.  Lógica Kanban (Principal)
   *****************************************************************/
  (async function main() {
    let isInitialLoad = true; 

    const pal = ["#1E88E5", "#43A047", "#FB8C00", "#E53935", "#8E24AA", "#00838F", "#6D4C41", "#546E7A"];
    const palette = i => pal[i % pal.length];
    const dbg = document.getElementById('dbg');
    const boardEl = document.getElementById('board');
    const errEl = document.getElementById('errorMsg');
    const editDrawerEl = document.getElementById('drawer');
    const editDrawerTitleEl = document.getElementById('drawerTitle');
    const editDrawerContentEl = document.getElementById('drawerContent');
    const editDrawerSaveBtn = document.getElementById('saveBtn');
    const editDrawerCloseBtn = document.getElementById('closeBtn');
    const editDrawerCancelBtn = document.getElementById('cancelBtnDrawer');
    const cfgBtn = document.getElementById('cfg-btn');
    if (dbg) dbg.onclick = () => dbg.classList.toggle('collapsed');
    const safe = (o, k, f = null) => (o && k in o && o[k] !== undefined && o[k] !== null) ? o[k] : f;
    let gristTableMeta = null, gristRows = [], allGristTables = [], gristTableOps = null, kanbanLanesStructure = [], currentEditingCardId = null, currentEditingCardData = null, currentVisibleCardsByLane = {}, refListCache = {};

    function formatEpoch(val, type) { const num = Number(val); if (isNaN(num) || num === 0) { return val; } const dateObj = new Date(num * 1000); if (isNaN(dateObj.valueOf())) return val; return type === 'Date' ? dateObj.toLocaleDateString(undefined, { timeZone: 'UTC' }) : dateObj.toLocaleString(undefined, { timeZone: 'UTC' }); }
    
    async function findBackReferenceColumn(tableA_Id, tableB_Schema) {
        const expectedRefType = `Ref:${tableA_Id}`;
        const col = tableB_Schema.columns.find(c => c.type === expectedRefType);
        if (col) return col.id;
        throw new Error(_('error_no_back_reference').replace('{tableB}', tableB_Schema.tableId).replace('{tableA}', tableA_Id));
    }

    async function populateRefListTable(containerEl, colDef, refListValue) {
        containerEl.innerHTML = `<p>${_('loading_linked_records')}</p>`;
        try {
            const tableA_Id = gristTableMeta.nameId;
            const tableB_Id = colDef.referencedTableId;
            const linkedRecordIds = Array.isArray(refListValue) && refListValue[0] === 'L' ? refListValue.slice(1) : [];
            const [tableB_Schema, allRefTableRecords] = await Promise.all([ GristDataManager.getTableSchema(tableB_Id), GristDataManager.colToRows(await grist.docApi.fetchTable(tableB_Id)) ]);
            const backRefColId = await findBackReferenceColumn(tableA_Id, tableB_Schema);
            const linkedRecords = allRefTableRecords.filter(r => linkedRecordIds.includes(r.id));
            containerEl.innerHTML = '';
            
            const controlsDiv = document.createElement('div'); controlsDiv.style.marginBottom = '8px';
            const addBtn = document.createElement('button'); addBtn.textContent = _('add_new');
            addBtn.onclick = () => handleRefListRecordAction(containerEl, colDef, tableB_Schema, backRefColId, null);
            controlsDiv.append(addBtn);
            containerEl.appendChild(controlsDiv);

            const table = document.createElement('table'); table.className = 'wip-limit-table'; containerEl.appendChild(table);
            const thead = table.createTHead(); const headerRow = thead.insertRow();
            
            const laneValue = String(safe(currentEditingCardData, WidgetConfigManager.getKanbanDefiningColumn(), ""));
            const parentConfig = WidgetConfigManager.getFieldConfigForLane(gristTableMeta.nameId, laneValue, colDef.id);
            
            const columnsToShow = tableB_Schema.columns
                .filter(c => {
                    const childConfig = parentConfig.refListFieldConfigs?.[c.id] || { visible: true };
                    return childConfig.visible !== false && c.id !== backRefColId && c.id !== 'manualSort';
                })
                .sort((a,b) => {
                    const posA = parentConfig.refListFieldConfigs?.[a.id]?.position ?? 99;
                    const posB = parentConfig.refListFieldConfigs?.[b.id]?.position ?? 99;
                    return posA - posB;
                });
                
            columnsToShow.forEach(c => { headerRow.insertCell().textContent = c.label; });
            headerRow.insertCell().textContent = _('actions');
            
            const tbody = table.createTBody();
            if (linkedRecords.length === 0) {
                const emptyRow = tbody.insertRow();
                const emptyCell = emptyRow.insertCell();
                emptyCell.colSpan = columnsToShow.length + 1;
                emptyCell.textContent = _('no_linked_records');
                emptyCell.style.textAlign = 'center'; emptyCell.style.fontStyle = 'italic';
            } else {
                linkedRecords.forEach(rec => {
                    const tr = tbody.insertRow(); tr.dataset.recordId = rec.id;
                    columnsToShow.forEach(c => {
                        const cell = tr.insertCell();
                        if (c.type === 'Bool') {
                            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!rec[c.id]; cb.disabled = true; cell.appendChild(cb);
                        } else {
                            cell.textContent = safe(rec, c.id, '');
                        }
                    });
                    const cellActions = tr.insertCell();
                    const editBtn = document.createElement('button'); editBtn.className = 'reflist-action-btn'; editBtn.textContent = '✏️'; editBtn.title = _('edit');
                    editBtn.onclick = () => handleRefListRecordAction(containerEl, colDef, tableB_Schema, backRefColId, rec);
                    const unlinkBtn = document.createElement('button'); unlinkBtn.className = 'reflist-action-btn'; unlinkBtn.textContent = '🗑️'; unlinkBtn.title = _('unlink');
                    unlinkBtn.onclick = () => handleRefListUnlink_Single(containerEl, colDef, tableB_Schema, backRefColId, rec.id);
                    cellActions.append(editBtn, unlinkBtn);
                });
            }
        } catch (err) {
            console.error("Failed to populate RefList table:", err);
            containerEl.innerHTML = `<p style="color:red;">${_('error_loading_list')}${err.message}</p>`;
        }
    }

    async function handleRefListRecordAction(containerEl, colDef, tableB_Schema, backRefColId, recordToEdit = null) {
        const isEditing = recordToEdit !== null;
        const modalTitle = isEditing ? _('edit_in_table').replace('{table}', tableB_Schema.tableId) : _('add_in_table').replace('{table}', tableB_Schema.tableId);
        const modal = document.createElement('div'); modal.className = 'replicate-modal';
        const content = document.createElement('div'); content.className = 'replicate-content'; content.style.width = '500px';
        modal.appendChild(content); content.innerHTML = `<h3>${modalTitle}</h3>`;
        const form = document.createElement('div'); form.id = 'reflist-add-form'; content.appendChild(form);

        const laneValue = String(safe(currentEditingCardData, WidgetConfigManager.getKanbanDefiningColumn(), ""));
        const parentConfig = WidgetConfigManager.getFieldConfigForLane(gristTableMeta.nameId, laneValue, colDef.id);
        
        tableB_Schema.columns
        .filter(c => {
            const childConfig = parentConfig.refListFieldConfigs?.[c.id] || { visible: true };
            return childConfig.visible !== false && !c.isFormula && c.id !== backRefColId && c.id !== 'id' && c.id !== 'manualSort';
        })
        .sort((a, b) => {
            const posA = parentConfig.refListFieldConfigs?.[a.id]?.position ?? 99;
            const posB = parentConfig.refListFieldConfigs?.[b.id]?.position ?? 99;
            return posA - posB;
        })
        .forEach(c => {
            const childConfig = parentConfig.refListFieldConfigs?.[c.id] || { editable: true };
            const fieldContainer = document.createElement('div'); fieldContainer.style.marginBottom = '10px';
            const label = document.createElement('label'); label.textContent = c.label; label.style.display = 'block'; label.style.fontWeight = 'bold';
            
            let input;
            const isEditable = childConfig.editable !== false;

            if (!isEditable) {
                input = document.createElement('div');
                input.className = 'readonly-field';
                input.textContent = isEditing ? (recordToEdit[c.id] || '') : _('not_editable');
            } else if (c.choices && c.choices.length > 0) {
                input = document.createElement('select'); input.add(new Option(_('select_option'), ''));
                c.choices.forEach(ch => input.add(new Option(ch, ch)));
                if (isEditing) input.value = recordToEdit[c.id] || '';
            } else if (c.type === 'Bool') {
                input = document.createElement('input'); input.type = 'checkbox';
                if (isEditing) input.checked = recordToEdit[c.id] || false;
            } else {
                input = document.createElement('input'); input.type = 'text';
                if (isEditing) input.value = recordToEdit[c.id] || '';
            }
            input.dataset.colId = c.id;
            if(isEditable) { input.style.width = '100%'; input.style.padding = '4px'; }
            fieldContainer.append(label, input);
            form.appendChild(fieldContainer);
        });

        const actions = document.createElement('div'); actions.style.marginTop = '15px';
        const saveBtn = document.createElement('button'); saveBtn.textContent = _('save_button');
        const cancelBtn = document.createElement('button'); cancelBtn.textContent = _('cancel_button'); cancelBtn.style.marginLeft = '8px';
        actions.append(saveBtn, cancelBtn); content.appendChild(actions);
        document.body.appendChild(modal);

        cancelBtn.onclick = () => document.body.removeChild(modal);
        saveBtn.onclick = async () => {
            try {
                saveBtn.disabled = true; saveBtn.textContent = _('saving');
                const fieldsToSave = {};
                form.querySelectorAll('[data-col-id]').forEach(inp => {
                    if (!inp.closest('.readonly-field')) {
                        fieldsToSave[inp.dataset.colId] = (inp.type === 'checkbox') ? inp.checked : inp.value;
                    }
                });
                
                if (!isEditing) { fieldsToSave[backRefColId] = currentEditingCardId; }
                const tableB_Ops = grist.getTable(tableB_Schema.tableId);
                if (isEditing) {
                    await tableB_Ops.update([{ id: recordToEdit.id, fields: fieldsToSave }]);
                } else {
                    await tableB_Ops.create([{ fields: fieldsToSave }]);
                }

                const rawData = await grist.docApi.fetchTable(gristTableMeta.nameId, [currentEditingCardId]);
                const updatedRecords = GristDataManager.colToRows(rawData);
                if (updatedRecords.length > 0) {
                    const updatedMainRecord = updatedRecords[0];
                    currentEditingCardData = updatedMainRecord; 
                    await populateRefListTable(containerEl, colDef, updatedMainRecord[colDef.id]);
                }
                
                document.body.removeChild(modal);
            } catch (err) {
                alert(_('error_saving') + err.message);
                console.error("Error saving RefList record:", err);
                saveBtn.disabled = false; saveBtn.textContent = _('save_button');
            }
        };
    }

    async function handleRefListUnlink_Single(containerEl, colDef, tableB_Schema, backRefColId, recordIdToUnlink) {
        if (!confirm(_('confirm_unlink'))) { return; }
        try {
            const tableB_Ops = grist.getTable(tableB_Schema.tableId);
            await tableB_Ops.update([{ id: recordIdToUnlink, fields: { [backRefColId]: null } }]);

            const rawData = await grist.docApi.fetchTable(gristTableMeta.nameId, [currentEditingCardId]);
            const updatedRecords = GristDataManager.colToRows(rawData);
            if (updatedRecords.length > 0) {
                const updatedMainRecord = updatedRecords[0];
                currentEditingCardData = updatedMainRecord;
                await populateRefListTable(containerEl, colDef, updatedMainRecord[colDef.id]);
            }
            
        } catch (err) {
            alert(_('error_unlink') + err.message);
            console.error("Error unlinking RefList record:", err);
        }
    }
    
    function getFieldDisplayConfig(gristFieldId, cardLaneValue) { if (!gristTableMeta || !gristFieldId || typeof cardLaneValue === 'undefined') { return { ...WidgetConfigManager.getDefaults(), visible: false, card: false }; } return WidgetConfigManager.getFieldConfigForLane(gristTableMeta.nameId, String(cardLaneValue), gristFieldId); }
    function applyStylesFromWidgetOptions(element, fieldDef, fieldValue, isLabel = false) {
        if (!element || !fieldDef || !fieldDef.widgetOptions) return;
        const wo = fieldDef.widgetOptions; let styleToApply = {};
        if (isLabel) { if (wo.headerFillColor) styleToApply.backgroundColor = wo.headerFillColor; if (wo.headerTextColor) styleToApply.color = wo.headerTextColor; if (wo.headerFontBold) styleToApply.fontWeight = 'bold'; if (wo.headerFontItalic) styleToApply.fontStyle = 'italic'; if (wo.headerFontUnderline) styleToApply.textDecoration = 'underline';
        } else {
            if (wo.fillColor) styleToApply.backgroundColor = wo.fillColor; if (wo.textColor) styleToApply.color = wo.textColor; if (wo.fontBold) styleToApply.fontWeight = 'bold'; if (wo.fontItalic) styleToApply.fontStyle = 'italic'; if (wo.fontUnderline) styleToApply.textDecoration = 'underline';
            if ((fieldDef.type === 'Choice' || fieldDef.type === 'ChoiceList') && wo.choiceOptions && fieldValue && wo.choiceOptions[String(fieldValue)]) { const choiceStyle = wo.choiceOptions[String(fieldValue)]; if (choiceStyle.fillColor) styleToApply.backgroundColor = choiceStyle.fillColor; if (choiceStyle.textColor) styleToApply.color = choiceStyle.textColor; if (typeof choiceStyle.fontBold !== 'undefined') styleToApply.fontWeight = choiceStyle.fontBold ? 'bold' : (wo.fontBold ? 'bold' : 'normal'); if (typeof choiceStyle.fontItalic !== 'undefined') styleToApply.fontStyle = choiceStyle.fontItalic ? 'italic' : (wo.fontItalic ? 'italic' : 'normal'); if (typeof choiceStyle.fontUnderline !== 'undefined') styleToApply.textDecoration = choiceStyle.fontUnderline ? 'underline' : 'none';
            } else if (fieldDef.type === 'Rules' && wo.rulesOptions && Array.isArray(wo.rulesOptions)) { const matchingRule = wo.rulesOptions.find(rule => { return false; }); if (matchingRule && matchingRule.style) { if (matchingRule.style.textColor) styleToApply.color = matchingRule.style.textColor; if (matchingRule.style.fillColor) styleToApply.backgroundColor = matchingRule.style.fillColor; } }
        }
        Object.assign(element.style, styleToApply);
    }

    function createCardElement(cardData, cardLaneValue) {
        const cardDiv = document.createElement('div'); cardDiv.className = 'card'; cardDiv.dataset.cardId = cardData.id;
        const vis = WidgetConfigManager.getVisualConfig();
        if (vis.cardColor) cardDiv.style.background = vis.cardColor;
        if (vis.cardShadow) { cardDiv.classList.add('with-shadow'); } else { cardDiv.classList.remove('with-shadow'); cardDiv.style.boxShadow = 'none'; }
        if (vis.cardFieldsFontColor) { cardDiv.style.color = vis.cardFieldsFontColor; }

        const laneInfo = kanbanLanesStructure.find(l => l.value === cardLaneValue) || { color: "#ccc" }; cardDiv.style.setProperty('--card-status-color', laneInfo.color); const sortCrit = WidgetConfigManager.getCardSortCriteria(); const prioCrit = sortCrit.find(c => c.displayType === 'priority' && c.columnId); if (prioCrit) { const fieldDef = gristTableMeta.columns.find(c => c.id === prioCrit.columnId); const raw = safe(cardData, prioCrit.columnId, ''); const el = document.createElement('div'); el.className = 'card-priority'; el.textContent = raw ?? ''; if (fieldDef) applyStylesFromWidgetOptions(el, fieldDef, raw, false); cardDiv.appendChild(el); } const dueCrit = sortCrit.find(c => c.displayType === 'dueDate' && c.columnId); if (dueCrit) { const fieldDef = gristTableMeta.columns.find(c => c.id === dueCrit.columnId); let rawVal = safe(cardData, dueCrit.columnId, ''); let displayVal = rawVal; if (fieldDef && (fieldDef.type === 'Date' || fieldDef.type === 'DateTime')) { displayVal = formatEpoch(rawVal, fieldDef.type); } const el2 = document.createElement('div'); el2.className = 'card-dueDate'; el2.textContent = displayVal ?? ''; if (fieldDef) applyStylesFromWidgetOptions(el2, fieldDef, rawVal, false); cardDiv.appendChild(el2); }
        let fieldsOnCardRaw = gristTableMeta.columns.map(col => ({ colDef: col, config: getFieldDisplayConfig(col.id, cardLaneValue) })).filter(item => item.config.card && item.colDef.id !== WidgetConfigManager.getKanbanDefiningColumn()).sort((a, b) => (a.config.cardPosition ?? 999) - (b.config.cardPosition ?? 999));
        let titleItemConfig = null; const idx0 = fieldsOnCardRaw.findIndex(i => i.config.cardPosition === 0); if (idx0 !== -1) titleItemConfig = fieldsOnCardRaw.splice(idx0, 1)[0]; else if (fieldsOnCardRaw.length > 0 && fieldsOnCardRaw[0].config.cardPosition > 0) titleItemConfig = fieldsOnCardRaw.shift();

        const titleEl = document.createElement('div');
        titleEl.className = 'card-title';
        if (vis.cardTitleFontColor) {
            titleEl.style.color = vis.cardTitleFontColor;
        }

        if (titleItemConfig) {
            const colDef = titleItemConfig.colDef;
            let titleValueToDisplay = safe(cardData, colDef.id);
            if (colDef.type.startsWith('Ref') && colDef.displayColId) {
                titleValueToDisplay = safe(cardData, colDef.displayColId, '');
                if (safe(cardData, colDef.id) === 0 || String(titleValueToDisplay).startsWith("E,Invalid")) {
                    titleValueToDisplay = `[${colDef.label}]`;
                }
            } else if (!colDef.type.startsWith('Ref') && (colDef.type === 'Date' || colDef.type === 'DateTime')) {
                titleValueToDisplay = formatEpoch(safe(cardData, colDef.id), colDef.type);
            }
            titleEl.textContent = titleValueToDisplay ?? `[${colDef.label}]`;
            if (titleItemConfig.config.useFormatting) {
                applyStylesFromWidgetOptions(titleEl, colDef, safe(cardData, colDef.id), false);
            }
        } else {
            titleEl.textContent = `${_('card_prefix')} ${cardData.id}`;
        }
        
        cardDiv.appendChild(titleEl);
        
        fieldsOnCardRaw.forEach(item => {
            const fieldDiv = document.createElement('div'); fieldDiv.className = 'card-field';
            const colDef = item.colDef;
            let rawValueFromGrist = safe(cardData, colDef.id);
            if (item.config.showLabel) {
                const lab = document.createElement('span');
                lab.className = 'label';
                lab.textContent = `${colDef.label}: `;
                if (item.config.useFormatting) {
                    applyStylesFromWidgetOptions(lab, colDef, rawValueFromGrist, true);
                }
                fieldDiv.appendChild(lab);
            }

            let fieldEl;
            if (colDef.type.startsWith('RefList')) {
                fieldEl = document.createElement('div');
                const linkedRecordIds = Array.isArray(rawValueFromGrist) && rawValueFromGrist[0] === 'L' ? rawValueFromGrist.slice(1) : [];
                const refTableId = colDef.referencedTableId;
                const linkedRecords = refListCache.data?.[refTableId]?.filter(r => linkedRecordIds.includes(r.id)) || [];

                if (item.config.useFormatting && linkedRecords.length > 0 && refListCache.schemas[refTableId]) {
                    fieldEl.className = 'card-reflist-wrapper';
                    const table = document.createElement('table');
                    table.className = 'card-reflist-table';
                    const thead = table.createTHead();
                    const headerRow = thead.insertRow();
                    
                    const refTableSchema = refListCache.schemas[refTableId];
                    const childColConfigs = item.config.refListFieldConfigs || {};
                    const childColsToShow = Object.values(childColConfigs)
                        .filter(c => c.card)
                        .sort((a, b) => (a.cardPosition || 99) - (b.cardPosition || 99))
                        .map(c => refTableSchema.columns.find(sc => sc.id === c.fieldId))
                        .filter(Boolean);

                    if (childColsToShow.length > 0) {
                        childColsToShow.forEach(cc => headerRow.insertCell().textContent = cc.label);
                        const tbody = table.createTBody();
                        linkedRecords.forEach(rec => {
                            const tr = tbody.insertRow();
                            childColsToShow.forEach(cc => tr.insertCell().textContent = safe(rec, cc.id, ''));
                        });
                        fieldEl.appendChild(table);
                    } else {
                        fieldEl.textContent = `${linkedRecords.length} item(ns) vinculado(s)`;
                    }
                } else {
                    if (linkedRecords.length > 0 && refListCache.schemas[refTableId]) {
                        const refTableSchema = refListCache.schemas[refTableId];
                        const displayCol = refTableSchema.columns.find(c => c.id === refTableSchema.primaryColId) || refTableSchema.columns.find(c => c.type === 'Text') || refTableSchema.columns[1] || { id: 'id' };
                        const names = linkedRecords.map(r => safe(r, displayCol.id, `ID ${r.id}`)).join(', ');
                        fieldEl.textContent = names;
                    } else {
                        fieldEl.textContent = `[${_('none')}]`;
                        fieldEl.style.fontStyle = 'italic';
                    }
                }
            } else {
                let displayValue = rawValueFromGrist;
                if (colDef.type.startsWith('Ref:') && colDef.displayColId) { displayValue = safe(cardData, colDef.displayColId, ''); if (rawValueFromGrist === 0 || String(displayValue).startsWith("E,Invalid")) { displayValue = `[${_('none')}]`; } }
                else if (colDef.type.startsWith('Ref:') && !colDef.displayColId) { displayValue = (rawValueFromGrist && rawValueFromGrist !== 0) ? `[Ref ID: ${rawValueFromGrist}]` : `[${_('none')}]`; }
                else if (colDef.type === 'Date' || colDef.type === 'DateTime') { displayValue = formatEpoch(rawValueFromGrist, colDef.type); }
                
                if (colDef.type === 'Bool') { fieldEl = document.createElement('input'); fieldEl.type = 'checkbox'; fieldEl.disabled = true; fieldEl.checked = Boolean(rawValueFromGrist); }
                else if (colDef.type === 'ChoiceList') { fieldEl = document.createElement('div'); const choicesSelected = Array.isArray(rawValueFromGrist) && rawValueFromGrist[0] === 'L' ? rawValueFromGrist.slice(1) : []; if (choicesSelected.length > 0) { choicesSelected.forEach(opt => { const chip = document.createElement('span'); chip.className = 'choice-chip'; chip.textContent = opt; if (item.config.useFormatting && colDef.widgetOptions?.choiceOptions?.[opt]) { const cs = colDef.widgetOptions.choiceOptions[opt]; if (cs.fillColor) chip.style.backgroundColor = cs.fillColor; if (cs.textColor) chip.style.color = cs.textColor; } fieldEl.appendChild(chip); }); } else { fieldEl.textContent = `[${_('none')}]`; fieldEl.style.fontStyle = 'italic'; fieldEl.style.color = '#757575'; } }
                else { fieldEl = document.createElement('span'); fieldEl.className = 'value'; fieldEl.textContent = displayValue ?? ''; if (displayValue === `[${_('none')}]`) { fieldEl.style.fontStyle = 'italic'; fieldEl.style.color = '#757575'; } }
                if (item.config.useFormatting && colDef.type !== 'ChoiceList') { applyStylesFromWidgetOptions(fieldEl, colDef, rawValueFromGrist, false); }
            }
            fieldDiv.appendChild(fieldEl);
            cardDiv.appendChild(fieldDiv);
        });
        cardDiv.onclick = () => openCardEditDrawer(cardData.id, cardLaneValue, cardData); return cardDiv;
    }

    async function renderKanbanView() {
        const vis = WidgetConfigManager.getVisualConfig(); boardEl.style.display = 'flex'; boardEl.style.justifyContent = vis.centerColumns ? 'center' : 'flex-start'; boardEl.innerHTML = ''; currentVisibleCardsByLane = {};
        if (!gristTableMeta || !WidgetConfigManager.getKanbanDefiningColumn()) { errEl.textContent = "Configure a coluna Kanban em ⚙️ Config > Geral > Mapeamento."; boardEl.innerHTML = `<p>${errEl.textContent}</p>`; return; }
        if (kanbanLanesStructure.length === 0) { errEl.textContent = "Nenhuma lane encontrada para a coluna Kanban definida."; boardEl.innerHTML = `<p>${errEl.textContent}</p>`; return; }
        
        refListCache = { schemas: {}, data: {} };
        const refListsToFetch = new Set();
        gristTableMeta.columns.forEach(col => { if(col.type.startsWith('RefList:')) refListsToFetch.add(col.referencedTableId); });
        
        const promises = [];
        for (const tableId of refListsToFetch) {
            promises.push(GristDataManager.getTableSchema(tableId).then(s => refListCache.schemas[tableId] = s));
            promises.push((async () => {
                const data = await grist.docApi.fetchTable(tableId);
                refListCache.data[tableId] = GristDataManager.colToRows(data);
            })());
        }
        await Promise.all(promises);
        
        const definingColId = WidgetConfigManager.getKanbanDefiningColumn(); const cardsByLane = {}; kanbanLanesStructure.forEach(l => cardsByLane[l.value] = []); gristRows.forEach(row => { const laneValue = String(safe(row, definingColId, "")); if (cardsByLane.hasOwnProperty(laneValue)) { cardsByLane[laneValue].push(row); } else { if (!cardsByLane["_UNMATCHED_LANE_"]) cardsByLane["_UNMATCHED_LANE_"] = []; cardsByLane["_UNMATCHED_LANE_"].push(row); } }); const sortCriteria = WidgetConfigManager.getCardSortCriteria(); if (sortCriteria.some(c => c.columnId)) { for (const lv in cardsByLane) { if (lv === "_UNMATCHED_LANE_") continue; cardsByLane[lv].sort((A, B) => { for (const c of sortCriteria) { if (!c.columnId) continue; const colMeta = gristTableMeta.columns.find(x => x.id === c.columnId); const vA = safe(A, c.columnId), vB = safe(B, c.columnId); let cmp = 0; if (vA == null && vB != null) cmp = 1; else if (vB == null && vA != null) cmp = -1; else if (vA == null && vB == null) cmp = 0; else if (colMeta && (colMeta.type === 'Numeric' || colMeta.type === 'Int' || colMeta.type === 'Date' || colMeta.type === 'DateTime')) { cmp = parseFloat(vA) - parseFloat(vB); } else { cmp = String(vA).localeCompare(String(vB), undefined, { sensitivity: 'base' }); } if (cmp !== 0) return c.direction === 'asc' ? cmp : -cmp; } return 0; }); } }
        kanbanLanesStructure.filter(l => !l.isUnmatched).forEach((lane, laneIndex) => { const columnDiv = document.createElement('div'); columnDiv.className = 'column'; columnDiv.dataset.laneValue = lane.value; columnDiv.style.flex = `0 0 ${vis.columnWidthPercent || 25}%`; columnDiv.style.minWidth = `${vis.columnMinWidth || 200}px`; columnDiv.style.maxWidth = `${vis.columnMaxWidth || 400}px`; if (vis.columnColor) columnDiv.style.backgroundColor = vis.columnColor; const headerDiv = document.createElement('div'); headerDiv.className = 'column-header'; headerDiv.style.backgroundColor = lane.color; headerDiv.style.color = lane.textColor; if (lane.fontBold) headerDiv.style.fontWeight = 'bold'; const totalInLane = (cardsByLane[lane.value] || []).length; const limits = WidgetConfigManager.getLaneWipLimit(lane.value); let headerText = `${lane.value || _('empty_value')} (${totalInLane}`; if (limits.maxAllowed > 0) { headerText += `/${limits.maxAllowed}`; if (totalInLane >= limits.maxAllowed) { headerDiv.classList.add('wip-limit-exceeded'); headerDiv.title = _('wip_limit_exceeded').replace('{limit}', limits.maxAllowed); } } headerText += ")"; headerDiv.textContent = headerText; columnDiv.appendChild(headerDiv); const addBtn = document.createElement('button'); addBtn.className = 'add-btn'; addBtn.textContent = _('new_card_button'); addBtn.onclick = () => { if (limits.maxAllowed > 0 && totalInLane >= limits.maxAllowed) { alert(_('error_wip_limit_reached').replace('{lane}', lane.value).replace('{limit}', limits.maxAllowed)); return; } addNewCardToLane(lane.value); }; columnDiv.appendChild(addBtn); const bodyDiv = document.createElement('div'); bodyDiv.className = 'column-body'; const cardsInThisLane = cardsByLane[lane.value] || []; currentVisibleCardsByLane[lane.value] = 0; const initiallyVisible = limits.maxVisible > 0 ? limits.maxVisible : CARDS_PER_PAGE; for (let i = 0; i < Math.min(cardsInThisLane.length, initiallyVisible); i++) { bodyDiv.appendChild(createCardElement(cardsInThisLane[i], lane.value)); currentVisibleCardsByLane[lane.value]++; } columnDiv.appendChild(bodyDiv); const pagDiv = document.createElement('div'); pagDiv.className = 'column-pagination-controls'; columnDiv.appendChild(pagDiv);
        function updatePaginationControls() { pagDiv.innerHTML = ''; const visibleCount = currentVisibleCardsByLane[lane.value]; const totalCount = cardsInThisLane.length; if (totalCount <= initiallyVisible && totalCount <= CARDS_PER_PAGE && limits.maxVisible === 0) { return; } if (totalCount > 0) { const showLessBtn = document.createElement('button'); showLessBtn.innerHTML = '▲'; showLessBtn.title = _('show_less'); showLessBtn.disabled = visibleCount <= (limits.maxVisible > 0 ? limits.maxVisible : CARDS_PER_PAGE); showLessBtn.onclick = () => { const targetVisible = limits.maxVisible > 0 ? limits.maxVisible : CARDS_PER_PAGE; Array.from(bodyDiv.querySelectorAll('.card')).slice(targetVisible).forEach(n => n.remove()); currentVisibleCardsByLane[lane.value] = Math.min(visibleCount, targetVisible); updatePaginationControls(); }; pagDiv.appendChild(showLessBtn); const countSpan = document.createElement('span'); countSpan.textContent = `(${visibleCount}/${totalCount})`; pagDiv.appendChild(countSpan); const showMoreBtn = document.createElement('button'); showMoreBtn.innerHTML = '▼'; showMoreBtn.title = _('show_more'); showMoreBtn.disabled = visibleCount >= totalCount; showMoreBtn.onclick = () => { const nextBatchStart = visibleCount; const nextBatchEnd = Math.min(totalCount, visibleCount + CARDS_PER_PAGE); for (let i = nextBatchStart; i < nextBatchEnd; i++) { bodyDiv.appendChild(createCardElement(cardsInThisLane[i], lane.value)); currentVisibleCardsByLane[lane.value]++; } updatePaginationControls(); }; pagDiv.appendChild(showMoreBtn); } }
        updatePaginationControls();
        new Sortable(bodyDiv, {
          group: 'kanban-cards', animation: 150,
          onMove: evt => { const toLaneValue = evt.to.closest('.column').dataset.laneValue; const fromLaneValue = evt.from.closest('.column').dataset.laneValue; const toLaneLimits = WidgetConfigManager.getLaneWipLimit(toLaneValue); const cardsInToLane = (cardsByLane[toLaneValue] || []).length; if (evt.from !== evt.to && toLaneLimits.maxAllowed > 0 && cardsInToLane >= toLaneLimits.maxAllowed) { console.log(`WIP Limit block: ${toLaneValue} has ${cardsInToLane}/${toLaneLimits.maxAllowed}`); return false; } if (WidgetConfigManager.getRestrictAdjacentMove()) { const fromLaneIdx = kanbanLanesStructure.findIndex(l => l.value === fromLaneValue); const toLaneIdx = kanbanLanesStructure.findIndex(l => l.value === toLaneValue); if (Math.abs(toLaneIdx - fromLaneIdx) > 1) { console.log("Adjacent move block"); return false; } } const fromLaneRules = WidgetConfigManager.getRulesForLane(fromLaneValue); const hasCreateRuleInFromLane = fromLaneRules.some(r => r.type === 'create'); if (hasCreateRuleInFromLane) { const fromIdx = kanbanLanesStructure.findIndex(l => l.value === fromLaneValue); const toIdx = kanbanLanesStructure.findIndex(l => l.value === toLaneValue); if (toIdx < fromIdx) { console.log("Cannot move back: 'create' rule exists in source lane."); return false; } } return true; },
          onEnd: async evt => { const cardId = parseInt(evt.item.dataset.cardId, 10); let destinationLaneValue = evt.to.closest('.column').dataset.laneValue; const sourceLaneValue = evt.from.closest('.column').dataset.laneValue; if (destinationLaneValue === sourceLaneValue && evt.oldIndex === evt.newIndex) return; const cardData = gristRows.find(r => r.id === cardId); if (!cardData) { console.error("Card data not found for ID:", cardId); evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex]); return; } const allowRulesManual = WidgetConfigManager.getRulesForLane(destinationLaneValue).filter(r => r.type === 'allow'); for (const rule of allowRulesManual) { if (!rule.fieldId || !rule.operator) continue; const actualValue = cardData[rule.fieldId]; const fieldDef = gristTableMeta.columns.find(c => c.id === rule.fieldId); const fieldType = fieldDef ? fieldDef.type : 'Text'; if (!evaluateCondition(actualValue, rule.operator, rule.value, fieldType)) { alert(_('error_move_not_allowed').replace('{lane}', destinationLaneValue).replace('{field}', fieldDef?.label || rule.fieldId).replace('{operator}', rule.operator).replace('{value}', rule.value)); evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex]); return; } } let cardMovedAutomatically = false; const moveRules = WidgetConfigManager.getRulesForLane(destinationLaneValue).filter(r => r.type === 'move'); for (const rule of moveRules) { if (!rule.fieldId || !rule.operator || !rule.targetLaneValue) continue; const actualValue = cardData[rule.fieldId]; const fieldDef = gristTableMeta.columns.find(c => c.id === rule.fieldId); const fieldType = fieldDef ? fieldDef.type : 'Text'; if (evaluateCondition(actualValue, rule.operator, rule.value, fieldType)) { console.log(`Regra 'move' disparada: movendo da ${destinationLaneValue} para ${rule.targetLaneValue}`); const allowRulesAutoMoveTarget = WidgetConfigManager.getRulesForLane(rule.targetLaneValue).filter(r => r.type === 'allow'); let autoMoveAllowed = true; for (const allowRuleTarget of allowRulesAutoMoveTarget) { if (!allowRuleTarget.fieldId || !allowRuleTarget.operator) continue; const valTarget = cardData[allowRuleTarget.fieldId]; const fdTarget = gristTableMeta.columns.find(c => c.id === allowRuleTarget.fieldId); const ftTarget = fdTarget ? fdTarget.type : 'Text'; if (!evaluateCondition(valTarget, allowRuleTarget.operator, allowRuleTarget.value, ftTarget)) { alert(_('error_auto_move_blocked').replace('{lane}', rule.targetLaneValue).replace('{field}', fdTarget?.label || allowRuleTarget.fieldId).replace('{operator}', allowRuleTarget.operator).replace('{value}', allowRuleTarget.value)); autoMoveAllowed = false; break; } } if (autoMoveAllowed) { destinationLaneValue = rule.targetLaneValue; cardMovedAutomatically = true; } else { console.log(`Movimento automático para ${rule.targetLaneValue} foi bloqueado por uma regra 'allow' da lane destino.`); } } } const definingColId = WidgetConfigManager.getKanbanDefiningColumn(); if (destinationLaneValue !== sourceLaneValue || cardMovedAutomatically) { try { console.log(`Atualizando Grist: Cartão ${cardId} para lane ${destinationLaneValue}`); await gristTableOps.update([{ id: cardId, fields: { [definingColId]: destinationLaneValue } }]); } catch (err) { console.error("Erro ao mover cartão (update Grist final):", err); alert(_('error_move_card') + err.message); evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex]); return; } } else if (destinationLaneValue === sourceLaneValue && evt.oldIndex !== evt.newIndex) { console.log("Cartão reordenado dentro da mesma lane. Nenhuma atualização de lane para Grist."); }
            if (destinationLaneValue !== sourceLaneValue) {
                const createRules = WidgetConfigManager.getRulesForLane(destinationLaneValue).filter(r => r.type === 'create');
                for (const rule of createRules) {
                    if (!rule.targetTableId || !rule.relationFieldIdInTarget || !rule.targetColumnIdForLane || rule.initialLaneValue === null || rule.initialLaneValue === undefined) { console.warn("Regra 'create' (simplificada) mal configurada ou lane inicial não definida:", rule); continue; }
                    try { const targetTable = grist.getTable(rule.targetTableId); if (!targetTable) { console.error(`Tabela de destino "${rule.targetTableId}" não encontrada para regra 'create'.`); continue; } const newRecordFields = { [rule.relationFieldIdInTarget]: cardId, [rule.targetColumnIdForLane]: rule.initialLaneValue }; console.log("Criando registro (simplificado) em subprocesso:", rule.targetTableId, newRecordFields); await targetTable.create([{ fields: newRecordFields }]); } catch (err) { console.error(`Erro ao executar regra 'create' (simplificada) para lane "${destinationLaneValue}":`, err); alert(_('error_create_subprocess').replace('{table}', rule.targetTableId) + err.message); }
                }
            }
          }
        });
        boardEl.appendChild(columnDiv);
      });
    }

    function openCardEditDrawer(cardId, cardLaneValue, preloadedCardData = null) {
        currentEditingCardId = cardId;
        const cardData = preloadedCardData || gristRows.find(r => r.id === cardId);
        if (!cardData) { console.warn(`openCardEditDrawer: Dados não encontrados para cardId ${cardId}`); return; }
        currentEditingCardData = { ...cardData };
        const drawerContent = editDrawerContentEl; drawerContent.innerHTML = '';
        const visualConfig = WidgetConfigManager.getVisualConfig();
        if (visualConfig.drawerFontColor) { drawerContent.style.color = visualConfig.drawerFontColor; }
        let cardTitle = `${_('edit_card_title')} ${cardId}`;
        const fieldsOnCard = gristTableMeta.columns.map(col => ({ colDef: col, config: getFieldDisplayConfig(col.id, cardLaneValue) })).filter(item => item.config.card).sort((a, b) => (a.config.cardPosition ?? 999) - (b.config.cardPosition ?? 999));
        const titleFieldConfiguredOnCard = fieldsOnCard.find(item => item.config.cardPosition === 0);
        if (titleFieldConfiguredOnCard) { const colDefForTitle = titleFieldConfiguredOnCard.colDef; let titleValue = safe(cardData, colDefForTitle.id); if (String(colDefForTitle.type).startsWith('Ref') && colDefForTitle.displayColId) { titleValue = safe(cardData, colDefForTitle.displayColId, `[Ref ${colDefForTitle.id}]`); } else if (!String(colDefForTitle.type).startsWith('Ref') && (colDefForTitle.type === 'Date' || colDefForTitle.type === 'DateTime')) { titleValue = formatEpoch(titleValue, colDefForTitle.type); } cardTitle = titleValue || `[${colDefForTitle.label}]`; } else if (fieldsOnCard.length > 0) { const firstFieldOnCard = fieldsOnCard[0].colDef; let titleValue = safe(cardData, firstFieldOnCard.id); if (String(firstFieldOnCard.type).startsWith('Ref') && firstFieldOnCard.displayColId) { titleValue = safe(cardData, firstFieldOnCard.displayColId, `[Ref ${firstFieldOnCard.id}]`); } else if (!String(firstFieldOnCard.type).startsWith('Ref') && (firstFieldOnCard.type === 'Date' || firstFieldOnCard.type === 'DateTime')) { titleValue = formatEpoch(titleValue, firstFieldOnCard.type); } cardTitle = titleValue || `[${firstFieldOnCard.label}]`;}
        editDrawerTitleEl.textContent = cardTitle;
        const fieldsForDrawer = gristTableMeta.columns.map(col => ({ colDef: col, config: getFieldDisplayConfig(col.id, cardLaneValue) })).filter(item => item.config.visible).sort((a, b) => (a.config.position || 999) - (b.config.position || 999));
        fieldsForDrawer.forEach(item => {
            const col = item.colDef; const cfg = item.config; let val = safe(currentEditingCardData, col.id, '');
            const label = document.createElement('label'); label.htmlFor = `field-${col.id}`; label.textContent = col.label; label.classList.add('formatted'); applyStylesFromWidgetOptions(label, col, val, true); drawerContent.appendChild(label);
            let inputEl; let displayValueForReadonly = val;
            if (col.type.startsWith('Ref:') && col.displayColId && cardData[col.displayColId] !== undefined) { displayValueForReadonly = safe(cardData, col.displayColId, ''); if (val === 0 || String(displayValueForReadonly).startsWith("E,Invalid")) { displayValueForReadonly = `[${_('none')}]`; }}
            else if (col.type.startsWith('Ref:') && !col.displayColId) { displayValueForReadonly = (val && val !== 0) ? `[Ref ID: ${val}]` : `[${_('none')}]`; }
            else if (col.type.startsWith('RefList') && col.displayColId && cardData[col.displayColId] !== undefined) { displayValueForReadonly = safe(cardData, col.displayColId, ''); const ids = Array.isArray(val) && val[0] === 'L' ? val.slice(1) : []; if (ids.length === 0) displayValueForReadonly = `[${_('none')}]`; }
            else if (col.type.startsWith('RefList') && !col.displayColId) { const ids = Array.isArray(val) && val[0] === 'L' ? val.slice(1) : []; displayValueForReadonly = ids.length > 0 ? ids.map(id => `[Ref ID: ${id}]`).join(', ') : `[${_('none')}]`; }
            else if (col.type === 'Date' || col.type === 'DateTime') { displayValueForReadonly = formatEpoch(val, col.type); }
            if (!cfg.editable || col.isFormula || col.id === WidgetConfigManager.getKanbanDefiningColumn()) {
                inputEl = document.createElement('div'); inputEl.className = 'readonly-field';
                if (col.type === 'ChoiceList') { const choices = Array.isArray(val) && val[0] === 'L' ? val.slice(1) : []; if(choices.length > 0) { choices.forEach(opt => { const chip = document.createElement('span'); chip.className = 'choice-chip'; chip.textContent = opt; if (col.widgetOptions?.choiceOptions?.[opt]) { const cs = col.widgetOptions.choiceOptions[opt]; if (cs.fillColor) chip.style.backgroundColor = cs.fillColor; if (cs.textColor) chip.style.color = cs.textColor; } inputEl.appendChild(chip); }); } else { inputEl.textContent = `[${_('none')}]`; inputEl.style.fontStyle="italic"; inputEl.style.color="#777";} }
                else if (col.type === 'Bool') { inputEl.textContent = Boolean(val) ? _('yes') : _('no'); }
                else if (col.type.startsWith('Ref')) { inputEl.textContent = displayValueForReadonly; if (displayValueForReadonly === `[${_('none')}]` || String(displayValueForReadonly).startsWith("[Ref ID:")) { inputEl.style.color = '#757575'; inputEl.style.fontStyle = 'italic'; } }
                else { inputEl.textContent = displayValueForReadonly ?? ''; }
                applyStylesFromWidgetOptions(inputEl, col, val, false);
            } else {
                if (col.type.startsWith('Ref:') && col.referencedTableId && !col.type.startsWith('RefList')) { inputEl = document.createElement('select'); inputEl.add(new Option(_('select_option'), '')); inputEl.dataset.currentRefValue = (val === 0 ? "" : String(val)); const populateRefSelect = async (selectElement, refTableId, currentRefId) => { selectElement.options[0].text = _('loading'); try { const rawRefTableData = await grist.docApi.fetchTable(refTableId); const refTableRecords = GristDataManager.colToRows(rawRefTableData); const refTableSchema = await GristDataManager.getTableSchema(refTableId); let displayRefColId = null; if (refTableSchema && refTableSchema.columns) { const commonDisplayNames = ['nome', 'name', 'title', 'título', 'label', 'rótulo', 'descricao', 'description']; let bestCandidate = refTableSchema.columns.find(c => commonDisplayNames.includes(c.label.toLowerCase()) && c.id.toLowerCase() !== 'id' && !c.id.startsWith('gristHelper_')); if (!bestCandidate) { bestCandidate = refTableSchema.columns.find(c => c.type === 'Text' && !c.isFormula && c.id.toLowerCase() !== 'id' && !c.id.startsWith('gristHelper_')); } if (!bestCandidate) { bestCandidate = refTableSchema.columns.find(c => !c.isFormula && c.id.toLowerCase() !== 'id' && !c.id.startsWith('gristHelper_')); } if (!bestCandidate && refTableSchema.columns.length > 0) { bestCandidate = refTableSchema.columns.find(c => c.id.toLowerCase() !== 'id' && !c.id.startsWith('gristHelper_')) || refTableSchema.columns[0]; } if (bestCandidate) { displayRefColId = bestCandidate.id; } else if (refTableRecords.length > 0 && Object.keys(refTableRecords[0]).length > 0) { displayRefColId = Object.keys(refTableRecords[0])[0]; } } selectElement.options[0].text = _('select_option'); refTableRecords.forEach(refRec => { const optionText = displayRefColId ? (safe(refRec, displayRefColId) ?? `ID ${refRec.id}`) : `ID ${refRec.id}`; selectElement.add(new Option(optionText, String(refRec.id))); }); selectElement.value = currentRefId || ""; } catch (err) { console.error(`Erro ao popular select de referência para tabela ${refTableId}:`, err); selectElement.options[0].text = _('error_loading_ref'); } }; populateRefSelect(inputEl, col.referencedTableId, inputEl.dataset.currentRefValue); }
                else if (col.type === 'ChoiceList') { inputEl = document.createElement('select'); inputEl.multiple = true; inputEl.size = Math.min(Math.max(3, (col.choices || []).length), 6); const currentValues = Array.isArray(val) && val[0] === 'L' ? val.slice(1) : []; (col.choices || []).forEach(choice => { const option = new Option(choice, choice); if (currentValues.includes(choice)) { option.selected = true; } applyStylesFromWidgetOptions(option, col, choice, false); inputEl.add(option); }); }
                else if (col.type.startsWith('RefList')) { inputEl = document.createElement('div'); inputEl.className = 'reflist-container'; inputEl.id = `reflist-container-${col.id}`; populateRefListTable(inputEl, col, val); }
                else if (col.type === 'Date' || col.type === 'DateTime') { inputEl = document.createElement('input'); inputEl.type = col.type === 'DateTime' ? 'datetime-local' : 'date'; if (val) { const dateObj = new Date(Number(val) * 1000); if (!isNaN(dateObj.valueOf())) { if (col.type === 'Date') { inputEl.value = dateObj.toISOString().split('T')[0]; } else { const localDate = new Date(dateObj.getTime() - (dateObj.getTimezoneOffset() * 60000)); inputEl.value = localDate.toISOString().slice(0,16); } } else { inputEl.value = ''; } } else { inputEl.value = ''; } applyStylesFromWidgetOptions(inputEl, col, val, false); }
                else if (col.type === 'Choice') {
                    inputEl = document.createElement('select'); inputEl.add(new Option(`-- ${_('none')} --`, ''));
                    (col.choices || []).forEach(choice => { const option = new Option(choice, choice); applyStylesFromWidgetOptions(option, col, choice, false); inputEl.add(option); });
                    inputEl.value = val; if (val) { applyStylesFromWidgetOptions(inputEl, col, val, false); }
                    inputEl.onchange = function() { if (this.value) { applyStylesFromWidgetOptions(this, col, this.value, false); } else { this.style.backgroundColor = ''; this.style.color = ''; } };
                }
                else if (col.type === 'Bool') { inputEl = document.createElement('input'); inputEl.type = 'checkbox'; inputEl.checked = Boolean(val); }
                else if (col.type === 'Int' || col.type === 'Numeric') { inputEl = document.createElement('input'); inputEl.type = 'number'; if (col.type === 'Numeric') inputEl.step = 'any'; inputEl.value = val; applyStylesFromWidgetOptions(inputEl, col, val, false); }
                else { inputEl = document.createElement('textarea'); inputEl.value = val; applyStylesFromWidgetOptions(inputEl, col, val, false); }
            }
            inputEl.id = `field-${col.id}`; if (!col.type.startsWith('RefList')) { inputEl.dataset.colId = col.id; }
            drawerContent.appendChild(inputEl);
        });
        editDrawerEl.classList.add('visible');
    }
    
    editDrawerSaveBtn.onclick = async () => { if (!currentEditingCardId || !currentEditingCardData || !gristTableOps) return; const fieldsToUpdate = {}; const definingColId = WidgetConfigManager.getKanbanDefiningColumn(); const currentLaneValueForDrawer = String(safe(currentEditingCardData, definingColId, "")); 
        editDrawerContentEl.querySelectorAll('[data-col-id]').forEach(inputEl => { 
            const colId = inputEl.dataset.colId; const colMeta = gristTableMeta.columns.find(c => c.id === colId); const cfg = getFieldDisplayConfig(colId, currentLaneValueForDrawer);
            if (cfg.editable && colMeta && !colMeta.isFormula && colId !== definingColId) {
                let newValue; const originalValue = currentEditingCardData[colId];
                if (inputEl.tagName === 'SELECT' && colMeta.type.startsWith('Ref:') && !colMeta.type.startsWith('RefList:')) { newValue = inputEl.value === "" ? 0 : Number(inputEl.value); }
                else if (inputEl.tagName === 'SELECT' && colMeta.type === 'ChoiceList' && inputEl.multiple) { const selectedOptions = Array.from(inputEl.selectedOptions).map(opt => opt.value); newValue = selectedOptions.length > 0 ? ['L', ...selectedOptions] : null; }
                else if (inputEl.type === 'checkbox' && inputEl.tagName === 'INPUT') { newValue = inputEl.checked; }
                else if (inputEl.type === 'number') { newValue = inputEl.value === '' ? null : parseFloat(inputEl.value); }
                else if (inputEl.type === 'date') { if (inputEl.value === '') { newValue = null; } else { const [year, month, day] = inputEl.value.split('-').map(Number); newValue = Date.UTC(year, month - 1, day) / 1000; } }
                else if (inputEl.type === 'datetime-local') { if (inputEl.value === '') { newValue = null; } else { newValue = new Date(inputEl.value).getTime() / 1000; } }
                else { newValue = (inputEl.value === '' && colMeta.type !== 'Text' && colMeta.type !== 'Any') ? null : inputEl.value; }
                let changed = false;
                if (colMeta.type === 'ChoiceList') { const originalArray = (Array.isArray(originalValue) && originalValue[0]==='L' ? originalValue.slice(1) : []).sort(); const newArray = (Array.isArray(newValue) && newValue[0]==='L' ? newValue.slice(1) : []).sort(); if (originalArray.join(',') !== newArray.join(',')) changed = true; }
                else if (colMeta.type.startsWith('Ref:')) { const origRefVal = originalValue === 0 ? null : Number(originalValue); const newRefVal = newValue === 0 ? null : Number(newValue); if (newRefVal !== origRefVal) changed = true; }
                else if (newValue !== originalValue && !(newValue == null && (originalValue == null || originalValue === ''))) { changed = true; }
                if (changed) { fieldsToUpdate[colId] = newValue; }
            }
        }); 
        if (Object.keys(fieldsToUpdate).length > 0) { console.log("Saving fields to Grist:", fieldsToUpdate); try { await gristTableOps.update([{ id: currentEditingCardId, fields: fieldsToUpdate }]); } catch (err) { console.error("Erro ao salvar cartão:", err); alert(_('error_save_card') + err.message); } } 
        editDrawerEl.classList.remove('visible'); currentEditingCardId = null; currentEditingCardData = null; };
    editDrawerCloseBtn.onclick = () => { editDrawerEl.classList.remove('visible'); currentEditingCardId = null; currentEditingCardData = null; };
    editDrawerCancelBtn.onclick = () => { editDrawerEl.classList.remove('visible'); currentEditingCardId = null; currentEditingCardData = null; };
    
        async function addNewCardToLane(laneValue) {
        if (!gristTableOps || !gristTableMeta) return;

        const definingColId = WidgetConfigManager.getKanbanDefiningColumn();
        if (!definingColId) {
            alert(_('error_kanban_column_not_defined'));
            return;
        }

        const newCardFields = {
            [definingColId]: laneValue
        };

        const titleFieldCand = gristTableMeta.columns.find(c => !c.isFormula && (c.label.toLowerCase() === 'title' || c.label.toLowerCase() === 'título' || c.label.toLowerCase() === 'nome'));
        
        if (titleFieldCand) {
            newCardFields[titleFieldCand.id] = _('new_card_title'); // LINHA CORRIGIDA
        }

        gristTableMeta.columns.forEach(col => {
            if (!newCardFields.hasOwnProperty(col.id) && !col.isFormula && col.id !== definingColId) {
                newCardFields[col.id] = (col.type.startsWith('Ref:') || col.type.startsWith('RefList:')) ? 0 : null;
            }
        });

        try {
            await gristTableOps.create([{
                fields: newCardFields
            }]);
        } catch (err) {
            console.error("Erro ao criar novo cartão:", err);
            alert(_('error_create_card') + err.message);
        }
    }
    
    ConfigUIBuilder.init({ drawerEl: document.getElementById('cfg-drawer'), saveBtnEl: document.getElementById('cfg-save'), cancelBtnEl: document.getElementById('cfg-cancel'), closeBtnEl: document.getElementById('cfg-close'), onSave: async () => { await WidgetConfigManager.saveConfig(); await loadGristDataAndSetupKanban(); } });
    
    if (cfgBtn) { 
        cfgBtn.onclick = async () => { 
            const drawer = document.getElementById('cfg-drawer');
            if(drawer.classList.contains('visible')){
                ConfigUIBuilder.close();
                return;
            }
            console.log("CFG Button: Clicked."); 
            await WidgetConfigManager.loadConfig(); 
            console.log("CFG Button: Config loaded."); 
            if (!gristTableMeta || (gristRows.length === 0 && gristTableMeta?.nameId) || allGristTables.length === 0) { 
                console.log("CFG Button: Fetching table meta, data, and all tables list..."); 
                const dataPack = await GristDataManager.fetchAll(); 
                if (!dataPack?.mainTable?.nameId) {
                    alert(_('error_no_table_selected'));
                    console.error("CFG Button: dataPack inválido ou sem mainTable."); return;
                } 
                gristTableMeta = dataPack.mainTable; 
                gristRows = dataPack.allData[gristTableMeta.nameId] || []; 
                allGristTables = dataPack.allTablesList || []; 
                console.log("CFG Button: Table meta, data, and all tables list fetched."); 
            } 
            let definingColIdFromConfig = WidgetConfigManager.getKanbanDefiningColumn(); 
            kanbanLanesStructure = []; 
            if (definingColIdFromConfig && gristTableMeta && gristTableMeta.columns.find(c => c.id === definingColIdFromConfig)) { 
                const definingColMeta = gristTableMeta.columns.find(c => c.id === definingColIdFromConfig); 
                if (definingColMeta) { 
                    let orderedLaneValues = definingColMeta.choices || []; 
                    if (orderedLaneValues.length === 0 && gristRows.length > 0) { 
                        const uniqueValuesFromData = new Set(); 
                        gristRows.forEach(r => { 
                            const v = r[definingColIdFromConfig]; 
                            if (v != null && v !== '') uniqueValuesFromData.add(String(v)); 
                        }); 
                        orderedLaneValues = Array.from(uniqueValuesFromData).sort(); 
                    } 
                    kanbanLanesStructure = orderedLaneValues.map((valStr, index) => { 
                        let laneColor = palette(index); 
                        let laneTextColor = '#fff'; 
                        let fontBold = false; 
                        if (definingColMeta.widgetOptions?.choiceOptions?.[valStr]) { 
                            const co = definingColMeta.widgetOptions.choiceOptions[valStr]; 
                            if (co.fillColor) laneColor = co.fillColor; 
                            if (co.textColor) laneTextColor = co.textColor; 
                            if (co.fontBold) fontBold = co.fontBold; 
                        } 
                        return { value: valStr, color: laneColor, textColor: laneTextColor, fontBold: fontBold, isUnmatched: false }; 
                    }); 
                } 
            } 
            if (gristTableMeta) { 
                ConfigUIBuilder.populateAndOpen(gristTableMeta, kanbanLanesStructure, allGristTables); 
            } else {
                alert(_('error_cannot_open_config'));
            } 
        }; 
    } else {
        console.error("Botão #cfg-btn não encontrado no DOM.");
        if (errEl) errEl.textContent = _('error_config_button_missing');
    }
    
    grist.ready({ requiredAccess: 'full', columns: [] });

    function applyWidgetVisualSettings() {
        const visualConfig = WidgetConfigManager.getVisualConfig(); const bodyStyle = document.body.style;
        if (visualConfig.backgroundType === 'linear' && visualConfig.gradientColor1 && visualConfig.gradientColor2) { bodyStyle.backgroundImage = `linear-gradient(${visualConfig.gradientDirection || 'to right'}, ${visualConfig.gradientColor1}, ${visualConfig.gradientColor2})`; bodyStyle.backgroundColor = visualConfig.gradientColor1; }
        else if (visualConfig.backgroundType === 'radial' && visualConfig.gradientColor1 && visualConfig.gradientColor2) { bodyStyle.backgroundImage = `radial-gradient(circle, ${visualConfig.gradientColor1}, ${visualConfig.gradientColor2})`; bodyStyle.backgroundColor = visualConfig.gradientColor1; }
        else { bodyStyle.backgroundImage = 'none'; bodyStyle.backgroundColor = visualConfig.solidBackgroundColor || WidgetConfigManager.getKanbanDefaults().visual.solidBackgroundColor; }
        const drawerElement = document.getElementById('drawer'); if (drawerElement && visualConfig.drawerFontColor) { drawerElement.style.color = visualConfig.drawerFontColor; }
    }

        async function loadGristDataAndSetupKanban() {
        console.log("MAIN.loadGristDataAndSetupKanban: Iniciando...");
        if (errEl) errEl.textContent = ''; if (boardEl) boardEl.innerHTML = `<p>${_('alert_loading_data')}</p>`;
        try {
            await WidgetConfigManager.loadConfig();

            // --- INÍCIO DA CORREÇÃO DE CARREGAMENTO ---
            // 1. Pega o idioma salvo na configuração
            currentLang = WidgetConfigManager.getLanguage();
            const langSelect = document.getElementById('cfg-lang-select');
            if (langSelect) { langSelect.value = currentLang; }

            // 2. Carrega o arquivo de idioma correspondente
            await loadLanguage(currentLang);

            // 3. SÓ AGORA traduz o conteúdo estático da página
            translatePageContent();
            // --- FIM DA CORREÇÃO DE CARREGAMENTO ---

            applyWidgetVisualSettings();
            const dataPack = await GristDataManager.fetchAll();
            if (!dataPack?.mainTable?.nameId) { if (errEl) errEl.textContent = "Falha ao buscar dados da tabela Grist. Verifique se uma tabela está selecionada."; if (boardEl) boardEl.innerHTML = ''; gristTableMeta = null; gristRows = []; allGristTables = []; return; }
            gristTableMeta = dataPack.mainTable; gristRows = dataPack.allData[gristTableMeta.nameId] || []; allGristTables = dataPack.allTablesList || []; gristTableOps = grist.getTable(gristTableMeta.nameId);
            let definingColId = WidgetConfigManager.getKanbanDefiningColumn();
            const currentFullConfig = await grist.getOption(CURRENT_CONFIG_KEY_FOR_GRIST);
            if (definingColId === null && gristTableMeta?.columns && typeof currentFullConfig === 'undefined') { const guessedStatusCol = gristTableMeta.columns.find(c => (c.label.toLowerCase() === 'status' || c.label.toLowerCase() === 'estado') && (c.type === 'Choice' || c.type === 'ChoiceList')); if (guessedStatusCol) { definingColId = guessedStatusCol.id; WidgetConfigManager.setKanbanDefiningColumn(definingColId); console.log(`Coluna Kanban PRÉ-SUGERIDA (primeiro uso ou config resetada): ${definingColId}. Usuário precisa salvar na UI de Config para persistir.`); } }
            
            kanbanLanesStructure = [];
            if (definingColId && gristTableMeta.columns.find(c => c.id === definingColId)) {
                const definingColMeta = gristTableMeta.columns.find(c => c.id === definingColId);
                let orderedLaneValues = definingColMeta.choices || [];
                if (orderedLaneValues.length === 0 && gristRows.length > 0) { const uniqueValuesFromData = new Set(); gristRows.forEach(r => { const v = r[definingColId]; if (v != null && String(v).trim() !== '') uniqueValuesFromData.add(String(v)); }); orderedLaneValues = Array.from(uniqueValuesFromData).sort((a,b) => String(a).localeCompare(String(b))); if (orderedLaneValues.length > 0) { console.warn("Lanes derivadas dos VALORES DOS DADOS (coluna sem 'choices' definidos). A ordem pode não ser a ideal. Defina 'choices' na coluna Grist para controlar a ordem das lanes."); } }
                if (orderedLaneValues.length === 0 && definingColMeta.type.startsWith("Ref")) { console.warn(`Coluna de Lane '${definingColMeta.label}' é do tipo Ref sem 'choices'. Lanes podem não aparecer corretamente sem dados ou configuração de choices explícita.`); }
                
                const uniqueLaneValues = [...new Set(orderedLaneValues)];
                uniqueLaneValues.forEach((laneValueStr, index) => {
                    let laneColor = palette(index); let laneTextColor = '#fff'; let fontBold = false;
                    if (definingColMeta.widgetOptions?.choiceOptions?.[laneValueStr]) { const co = definingColMeta.widgetOptions.choiceOptions[laneValueStr]; if (co.fillColor) laneColor = co.fillColor; if (co.textColor) laneTextColor = co.textColor; if (co.fontBold) fontBold = co.fontBold; }
                    kanbanLanesStructure.push({ value: String(laneValueStr), color: laneColor, textColor: laneTextColor, fontBold: fontBold, isUnmatched: false });
                });
                if (kanbanLanesStructure.length === 0 && definingColMeta) { if(errEl) errEl.textContent = _('error_no_choices_defined').replace('{column}', definingColMeta.label).replace('{columnId}', definingColId); }
            } else if (definingColId) { if (errEl) errEl.textContent = _('error_kanban_column_not_found').replace('{columnId}', definingColId).replace('{table}', gristTableMeta.nameId);
            } else { if (errEl) errEl.textContent = _('error_kanban_not_configured'); }
            
            await renderKanbanView();
            isInitialLoad = false;
        } catch (error) {
            console.error("Erro CRÍTICO em loadGristDataAndSetupKanban:", error);
            if (errEl) errEl.textContent = _('error_loading_check_console').replace('{error}', error.message);
            if (boardEl) boardEl.innerHTML = '';
        }
        console.log("MAIN.loadGristDataAndSetupKanban: Concluído.");
    }

    grist.onRecords(async (newRecords, oldRecords, summaryOrTableId) => {
        if (isInitialLoad) { 
          console.log("grist.onRecords: Ignorando chamada inicial.");
          return;
        }
        console.log("grist.onRecords triggered. Reloading Kanban.");
        await loadGristDataAndSetupKanban();
    });

    grist.onRecord(async (updatedRec, oldRec, summaryOrTableId) => {
        let tableId = null;
        if (summaryOrTableId && typeof summaryOrTableId === 'object' && summaryOrTableId.tableId) { tableId = summaryOrTableId.tableId; } 
        else if (typeof summaryOrTableId === 'string') { tableId = summaryOrTableId; } 
        else if (updatedRec && gristTableMeta && gristTableMeta.nameId) { tableId = gristTableMeta.nameId; }

        if (gristTableMeta && tableId === gristTableMeta.nameId && updatedRec) {
            if (currentEditingCardId === updatedRec.id && editDrawerEl.classList.contains('visible')) {
                const definingColId = WidgetConfigManager.getKanbanDefiningColumn();
                const currentLaneValueForDrawer = String(safe(updatedRec, definingColId, ""));
                try {
                    const rawFullData = await grist.docApi.fetchTable(gristTableMeta.nameId, [updatedRec.id]);
                    const fullCardDataArr = GristDataManager.colToRows(rawFullData);
                    if (fullCardDataArr.length > 0) {
                        openCardEditDrawer(fullCardDataArr[0].id, currentLaneValueForDrawer, fullCardDataArr[0]);
                    }
                } catch (fetchErr) {
                    console.error(`GRIST.ONRECORD: Erro ao buscar dados completos para o cartão ${updatedRec.id}:`, fetchErr);
                }
            }
        }
    });
    
    // Carrega o idioma padrão primeiro
    await loadLanguage(currentLang);

    // Initial load call
    loadGristDataAndSetupKanban();
    
// --- LÓGICA DE TROCA DE IDIOMA ---
    const langSelect = document.getElementById('cfg-lang-select');

    // A função agora é 'async' para poder usar 'await'
async function setLanguageAndReload(langCode) {
        try {
            // Se o idioma não mudou, não faz nada
            if (langCode === currentLang) return;

            // --- INÍCIO DA CORREÇÃO ---
            // 1. ATUALIZA A CONFIGURAÇÃO EM MEMÓRIA PRIMEIRO
            WidgetConfigManager.setLanguage(langCode);
            
            // 2. SALVA A CONFIGURAÇÃO INTEIRA NO GRIST
            await WidgetConfigManager.saveConfig();
            // --- FIM DA CORREÇÃO ---

            // 3. AGORA, RECARREGA TUDO (ele vai ler a configuração que acabamos de salvar)
            await loadGristDataAndSetupKanban(); 
            
            const configDrawer = document.getElementById('cfg-drawer');
            if (configDrawer && configDrawer.classList.contains('visible')) {
                // Força o fechamento e reabertura para garantir que o conteúdo dinâmico
                // (listas de colunas, etc.) seja re-traduzido.
                cfgBtn.click();
                setTimeout(() => cfgBtn.click(), 10);
            }
        } catch (error) {
            console.error(`Error changing language to ${langCode}:`, error);
        }
    }

    // Adiciona o listener para quando o usuário mudar o valor do select
    if (langSelect) {
        langSelect.onchange = (event) => setLanguageAndReload(event.target.value);
    }
    // --- FIM DA LÓGICA DE TROCA DE IDIOMA -

  })(); // Fim da função main()

  // Traduz o conteúdo da página pela primeira vez ao carregar.
  translatePageContent();
});
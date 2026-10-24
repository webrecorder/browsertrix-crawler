class ageBehavior
{
    static id = "age_form_completion_behavior"

    static possible_controls = [
            "button",
            "input:not([type='hidden'])",
            "select",
            "textarea",
            "[role='button']",
            "[role='combobox']",
            "[role='checkbox']",
            "[role='radio']",
            "[role='menuitem']",
            "[role='option']",
            "[contenteditable='true']"
        ].join(", ");

    static isMatch(){
        return true;
    }

    static init(){
        return{};
    }
     
    isUnobstructed(element) {
        const rect = element.getBoundingClientRect();

        if (rect.width == 0 || rect.height == 0) {
            return false;
        }

        const x = Math.min(window.innerWidth - 1, rect.left + rect.width / 2)
        const y = Math.min(window.innerHeight - 1, rect.top + rect.height / 2)
        const topElement = document.elementFromPoint(Math.max(0, x), Math.max(0, y));

        return (topElement === element || element.contains(topElement));
    }

    isVisible(element){
        return element.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true
        });
    }
    
    linkFilter(link){
        if(!this.isVisible(link) || !this.isUnobstructed(link)){
            return false;
        }

        const utilityPathPattern = /(?:^|\/)(?:privacy(?:-policy)?|cookie(?:-policy|-settings)?|terms(?:-of-use|-and-conditions)?|legal|accessibility|do-not-sell)(?:\/|$)/i;
        const destination = new URL(link.getAttribute("href"), window.location.href);
        const isUtilityPath = utilityPathPattern.test(destination.pathname);
        return (destination.origin === window.location.origin && !isUtilityPath)
    }

    controlsFilter(control){
        if(!this.isVisible(control) || !this.isUnobstructed(control) || control.disabled || control.getAttribute("aria-disabled") === "true"){
            return false;
        }
        return true;
    }

    map_controls(controls){
        let ctrl_id_count = 0;
        let mappings = [];
        for(let i = 0; i < controls.length; i++){
            const id = "control-" + ctrl_id_count;
            controls[i].removeAttribute("data-bx-agent-control");
            controls[i].setAttribute("data-bx-agent-control", id);
            mappings.push({
                id: id,
                tag: controls[i].tagName.toLowerCase(),
                type: controls[i].getAttribute("type"),
                name:
                    controls[i].getAttribute("aria-label") ||
                    controls[i].getAttribute("placeholder") ||
                    controls[i].getAttribute("name") ||
                    controls[i].textContent?.trim() ||
                    "",
            });
            ctrl_id_count++;
        }
        return mappings;
    }

    //Determine if agent is needed based on page sparsity. 
    agentNeeded(ctx, controls){
        const visible_same_origin_links = Array.from(document.querySelectorAll("a[href]")).filter((link) => this.linkFilter(link));
        const visibleText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const visibleCharacterCount = visibleText.length;
        //if the page is sparse and actionable then the agent should be called
        ctx.log(`AGENT CHECK FOUND: link count: ${visible_same_origin_links.length}, character count: ${visibleCharacterCount},
            viable controls count: ${controls.length}`);
        return (visible_same_origin_links.length < 3 && visibleCharacterCount < 3000 && controls.length > 0);
    }

    async* run(ctx){
        let viable_controls = Array.from(document.querySelectorAll(ageBehavior.possible_controls)).filter((control) => this.controlsFilter(control));
        let llm_controls = this.map_controls(viable_controls);
        const listener_url = "http://host.docker.internal:5055/test";
        let llm_call_count = 0;
        while(this.agentNeeded(ctx, llm_controls)){
            if(llm_call_count > 4){
                break;
            }
            const observation = {url: window.location.href, controls: JSON.stringify(llm_controls)};
            const llm_response = await self.__bx_agentBridge(observation, listener_url);
            ctx.log(`response from LLM: ${llm_response.status} ${llm_response.error ?? ""}`);
        
            if(llm_response.status === "error"){
                return;
            }

            const sleep_dur = 2000;
            for(let i = 0; i < llm_response.actions.length; i++){
                const action = llm_response.actions[i];
                ctx.log(`exucting action from LLM: ${action.type}: ${action.value}, reason: ${action.reason}"`);
                if(action.action === "done"){
                    break;
                }

                let message = await self.__bx_executeAgentAction(action);
                ctx.log(`Action Result: ${message}`);
                ctx.log(`sleeping ${sleep_dur}ms between LLM actions`)
                await ctx.Lib.sleep(sleep_dur);
            }

            viable_controls = Array.from(document.querySelectorAll(ageBehavior.possible_controls)).filter((control) => this.controlsFilter(control));
            llm_controls = this.map_controls(viable_controls);
            llm_call_count++;
        }
    }
}

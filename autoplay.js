(() => {

  function run() {
    if (window.navigator.__crawler_autoplay) {
      return;
    }

    //console.log("checking autoplay for " + document.location.href);
    window.navigator.__crawler_autoplay = true;

    const specialActions = [
      {
        rx: /w\.soundcloud\.com/,
        check(url) {
          const autoplay = url.searchParams.get('auto_play');
          return autoplay === 'true';
        },
        handle(url) {
          url.searchParams.set('auto_play', 'true');
          // set continuous_play to true in order to handle
          // a playlist etc
          url.searchParams.set('continuous_play', 'true');
          self.location.href = url.href;
        },
      },
      {
        rx: [/player\.vimeo\.com/, /youtube\.com\/embed\//],
        check(url) {
          const autoplay = url.searchParams.get('autoplay');
          return autoplay === '1';
        },
        handle(url) {
          url.searchParams.set('autoplay', '1');
          if (window.__crawler_autoplayLoad) {
            window.__crawler_autoplayLoad(url.href);
          }
          self.location.href = url.href;
        },
      },
    ];
    const url = new URL(self.location.href);
    for (let i = 0; i < specialActions.length; i++) {
      if (Array.isArray(specialActions[i].rx)) {
        const rxs = specialActions[i].rx;
        for (let j = 0; j < rxs.length; j++) {
          if (url.href.search(rxs[j]) >= 0) {
            if (specialActions[i].check(url)) return;
            return specialActions[i].handle(url);
          }
        }
      } else if (url.href.search(specialActions[i].rx) >= 0) {
        if (specialActions[i].check(url)) return;
        return specialActions[i].handle(url);
      }
    }
  }

  document.addEventListener("readystatechange", run);

  if (document.readyState === "complete") {
    run();
  }


  const mediaSet = new Set();

  setInterval(() => {
    const medias = document.querySelectorAll("video, audio");

    for (const media of medias) {
      try {
        if (media.src && !mediaSet.has(media.src)) {
          if (window.__crawler_queueUrls && (media.src.startsWith("http:") || media.src.startsWith("https:"))) {
            window.__crawler_queueUrls(media.src);
          }
          mediaSet.add(media.src);
        } else if (!media.src) {
          media.play();
        }
      } catch(e) {
        console.log(e);
      }
    }
  }, 3000);

 

})();


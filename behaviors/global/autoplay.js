// ===========================================================================
function autoplay() {
  function run() {
    if (self.navigator.__crawler_autoplay) {
      return;
    }

    function loadAutoplay(url) {
      if (self.__crawler_autoplayLoad) {
        self.__crawler_autoplayLoad(url);
      }
      // delay to allow splash image to load
      setTimeout(() => self.location.href = url, 1000);
    }

    //console.log("checking autoplay for " + document.location.href);
    self.navigator.__crawler_autoplay = true;

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
          loadAutoplay(url.href);
        },
      },
      {
        rx: [/player\.vimeo\.com/, /youtube(?:-nocookie)?\.com\/embed\//],
        check(url) {
          const autoplay = url.searchParams.get('autoplay');
          return autoplay === '1';
        },
        handle(url) {
          url.searchParams.set('autoplay', '1');
          loadAutoplay(url.href);
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

  self.document.addEventListener("readystatechange", run);

  if (self.document.readyState === "complete") {
    run();
  }


  const mediaSet = new Set();

  setInterval(() => {
    const medias = self.document.querySelectorAll("video, audio");

    for (const media of medias) {
      try {
        if (media.src && !mediaSet.has(media.src)) {
          if (self.__crawler_queueUrls && (media.src.startsWith("http:") || media.src.startsWith("https:"))) {
            self.__crawler_queueUrls(media.src);
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

};


// ===========================================================================
class AutoPlayBehavior
{
  constructor() {
    this.mediaPromises = [];
    this.waitForVideo = false;
  }

  async beforeLoad(page, crawler) {
    try {
      await page.exposeFunction("__crawler_queueUrls", async (url) => {
        this.mediaPromises.push(crawler.directFetchCapture(url));
      });

      await page.exposeFunction("__crawler_autoplayLoad", (url) => {
        console.log("*** Loading autoplay URL: " + url);
        this.waitForVideo = true;
      });

      const iife = `(${autoplay.toString()})();`;
      await page.evaluateOnNewDocument(iife);
 
    } catch(err) {
      console.log(err);
    }
  }

  async afterLoad(page, crawler) {
    try {
      await Promise.all(this.mediaPromises);
    } catch (e) {
      console.log("Error loading media URLs", e);
    }

    if (this.waitForVideo) {
      console.log("Extra wait 15s for video loading");
      await crawler.sleep(15000);
    }
  }
}




module.exports = AutoPlayBehavior


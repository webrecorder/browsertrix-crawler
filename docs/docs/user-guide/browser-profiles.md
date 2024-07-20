# Creating and Using Browser Profiles

Browsertrix Crawler can use existing browser profiles when running a crawl. This allows the browser to be pre-configured by logging in to certain sites or changing other settings, before running a crawl. By creating a logged in profile, the actual login credentials are not included in the crawl, only (temporary) session cookies.

## Interactive Profile Creation

Interactive profile creation is used for creating profiles of more complex sites, or logging in to multiple sites at once.

To use this mode, don't specify `--username` or `--password` flags and expose two ports on the Docker container to allow DevTools to connect to the browser and to serve a status page.

In profile creation mode, Browsertrix Crawler launches a browser which uses a VNC server (via [noVNC](https://novnc.com/)) running on port 6080 to provide a 'remote desktop' for interacting with the browser.

After interactively logging into desired sites or configuring other settings, _Create Profile_ should be clicked to initiate profile creation. Browsertrix Crawler will then stop the browser, and save the browser profile.

To start in interactive profile creation mode, run:

```sh
docker run -p 6080:6080 -p 9223:9223 -v $PWD/crawls/profiles:/crawls/profiles/ -it webrecorder/browsertrix-crawler create-login-profile --url "https://example.com/"
```

Then, open a browser pointing to `http://localhost:9223/` and use the embedded browser to log in to any sites or configure any settings as needed.

Click _Create Profile_ at the top when done. The profile will then be created in `./crawls/profiles/profile.tar.gz` containing the settings of this browsing session.

It is also possible to use an existing profile via the `--profile` flag. This allows previous browsing sessions to be extended as needed.

```sh
docker run -p 6080:6080 -p 9223:9223 -v $PWD/crawls/profiles:/crawls/profiles -it webrecorder/browsertrix-crawler create-login-profile --url "https://example.com/" --filename "/crawls/profiles/newProfile.tar.gz" --profile "/crawls/profiles/oldProfile.tar.gz"
```

## Headless vs Headful Profiles

Browsertrix Crawler supports both headful and headless crawling. We have historically recommended using headful crawling to be most accurate to user experience, however, headless crawling may be faster and in recent versions of Chromium-based browsers should be much closer in fidelity to headful crawling.

To use profiles in headless mode, profiles should also be created with `--headless` flag.

When creating browser profile in headless mode, Browsertrix will use the devtools protocol on port 9222 to stream the browser interface.

To create a profile in headless mode, run:

```sh
docker run -p 9222:9222 -p 9223:9223 -v $PWD/crawls/profiles:/crawls/profiles/ -it webrecorder/browsertrix-crawler create-login-profile --headless --url "https://example.com/"
```

## Automated Profile Creation for User Login

If the `--automated` flag is provided, Browsertrix Crawler will attempt to create a profile automatically after logging in to sites with a username and password. The username and password can be provided via `--username` and `--password` flags or, if omitted, from a command-line prompt.

When using `--automated` or `--username` / `--password`, Browsertrix Crawler will not launch an interactive browser and instead will attempt to finish automatically.

The automated profile creation system will log in to a single website with supplied credentials and then save the profile.

The script profile creation system also take a screenshot so you can check if the login succeeded.

!!! example "Example: Launch a browser and login to the digipres.club Mastodon instance"

	To automatically created a logged-in browser profile, run:

	```bash
	docker run -v $PWD/crawls/profiles:/crawls/profiles -it webrecorder/browsertrix-crawler create-login-profile --url "https://digipres.club/"
	```

	The script will then prompt you for login credentials, attempt to login, and create a tar.gz file in `./crawls/profiles/profile.tar.gz`.

- The `--url` parameter should specify the URL of a login page.

- To specify a custom filename, pass along `--filename` parameter.

- To specify the username and password on the command line (for automated profile creation), pass `--username` and `--password` flags.

- To specify headless mode, add the `--headless` flag. Note that for crawls run with `--headless` flag, it is recommended to also create the profile with `--headless` to ensure the profile is compatible.

- To specify the window size for the profile creation embedded browser, specify `--windowSize WIDTH,HEIGHT`. (The default is 1600x900)

The profile creation script attempts to detect the username and password fields on a site as generically as possible, but may not work for all sites.

## Using Browser Profile with a Crawl

To use a previously created profile with a crawl, use the `--profile` flag or `profile` option. The `--profile` flag can then be used to specify any Brave Browser profile stored as a tarball. Browser profile can be either stored locally and provided as a path, or available online at any HTTP(S) URL which will be downloaded before starting the crawl. Using profiles created with same or older version of Browsertrix Crawler is recommended to ensure compatibility. This option allows running a crawl with the browser already pre-configured, logged in to certain sites, language settings configured, etc.

After running the above command, you can now run a crawl with the profile, as follows:

```bash
docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --profile /crawls/profiles/profile.tar.gz --url https://digipres.club/ --generateWACZ --collection test-with-profile
```

Profiles can also be loaded from an http/https URL, eg. `--profile https://example.com/path/to/profile.tar.gz`.

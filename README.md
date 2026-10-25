[![CodeFactor rating badge](https://www.codefactor.io/repository/github/motioneye-project/motioneye/badge)](https://www.codefactor.io/repository/github/motioneye-project/motioneye)

# What is motionEye?

**motionEye** is an online interface for the software [_motion_](https://motion-project.github.io/), a video surveillance program with motion detection.

Check out the [__wiki__](https://github.com/motioneye-project/motioneye/wiki) for more details. Changelog is available on the [__releases page__](https://github.com/motioneye-project/motioneye/releases).

From version 0.43, **motionEye** is multilingual:

| [![](https://hosted.weblate.org/widgets/motioneye-project/-/287x66-black.png)<br>![](https://hosted.weblate.org/widgets/motioneye-project/-/multi-auto.svg)](https://hosted.weblate.org/engage/motioneye-project/) |
| -: |

You can contribute to translations on [__Weblate__](https://hosted.weblate.org/projects/motioneye-project).

# Features

This fork adds a flexible camera-grid overlay on top of motionEye's
standard interface. It ships as two new files plus two lines in the
main template — no motionEye code is replaced — and everything below
is an addition, not a change to how motionEye itself works.

- **Free layout: move anything, anywhere.** Turn on Free mode and
  drag any camera window to any spot on the page — grab the video
  itself, or the ✥ handle — even into gaps the grid could never
  fill. Windows can overlap, and the one you grab comes to the
  front. The button reads "Free ON" while active, so the mode is
  always obvious. Turn Free off and everything drops back into
  the grid, exactly where it was, with your free arrangement saved
  for next time.
- **Drag & drop resizing.** Drag a window's corner to resize it to
  any width, or cycle through preset sizes with one click. Sizes are
  remembered per camera, so your layout survives a reload.
- **Hide cameras, keep them as PiP.** Press H on a camera to hide
  its main view — it stays available as a picture-in-picture
  source, so it can appear ONLY as an inset inside another camera
  and never twice on screen. An eye button in the top bar lists
  hidden cameras with a Show button each (plus Show all). Hidden
  cameras stay hidden across refreshes.
- **Auto-hide toolbars & footer.** After a few idle seconds the
  header, footer, and all on-window buttons fade away for a clean,
  distraction-free view. Move the mouse and the buttons return; the
  header stays hidden until you ask for it, with one click on the
  floating button. The floating toolbar itself can be dragged
  anywhere, so it is never in the way.
- **Picture-in-picture (PiP).** Press the P button on any camera to
  open a live inset of another camera inside it. Drag the inset
  anywhere within that window, resize it by its corner, and switch
  cameras from its dropdown, all without leaving the main view.
  Insets save with your prefs, so a reload brings them straight
  back.
- **Independent window controls.** Every window carries its own
  size, PiP, hide, and move controls, so each camera can be
  arranged on its own terms while the rest of the grid stays put.

Everything you arrange — sizes, free-layout spots, insets, hidden
cameras — saves with your motionEye user prefs and comes back
after a reload.

Designed for a clean, flexible interface that maximizes screen space
while keeping essential controls accessible.

# Installation

1. Install **Python 3.9 or later** and build dependencies

    _Here the commands for APT-based Linux distributions are given._

    Thanks to pre-compiled wheels from PyPI, installing motionEye usually does not require anything but Python 3 and cURL with the ability to do HTTPS network requests:

    ```sh
    sudo apt update
    sudo apt --no-install-recommends install ca-certificates curl python3
    ```

    On **ARMv6/ARMv7 (32-bit), RISC-V, and other rare CPU architectures** additional build dependencies may be required to compile the [Pillow](https://pypi.org/project/pillow/), [PycURL](https://pypi.org/project/pycurl/), and [CFFI](https://github.com/python-cffi/cffi) modules:

    ```sh
    sudo apt --no-install-recommends install python3-dev gcc libjpeg62-turbo-dev libcurl4-openssl-dev libssl-dev libffi-dev
    ```

2. Install the Python package manager `pip`

    ```sh
    curl -sSfO 'https://bootstrap.pypa.io/get-pip.py'
    sudo python3 get-pip.py
    rm get-pip.py
    ```

    **On recent distro versions, like Debian 12/Bookworm, Ubuntu 23.04/Lunar, and later**, the `libpython3.*-stdlib` package ships a file `/usr/lib/python3.*/EXTERNALLY-MANAGED`, which prevents the installation of Python modules outside of `venv` environments.
    motionEye however has a small number of dependencies with no strict version requirements and hence is very unlikely to break any Python package you might have installed via APT. To bypass this block, add `break-system-packages=true` to the `[global]` section of your `pip.conf`:

    ```sh
    grep -q '\[global\]' /etc/pip.conf 2> /dev/null || printf '%b' '[global]\n' | sudo tee -a /etc/pip.conf > /dev/null
    sudo sed -i '/^\[global\]/a\break-system-packages=true' /etc/pip.conf
    ```

3. Install and setup **motionEye**

    ```sh
    sudo python3 -m pip install motioneye
    sudo motioneye_init
    ```

    _NB: `motioneye_init` currently assumes either an APT- or RPM-based distribution with `systemd` as init system. For a manual setup, config and service files can be found here: <https://github.com/motioneye-project/motioneye/tree/dev/motioneye/extra>_

4. Access the web interface

    After having successfully followed the installation instructions, the motionEye server should be running on your system and listening on port **8765**. Fire up your favorite web browser and visit the following URL (replacing `[your_ip]` with... well, your system's IP address):

    ```
    http://[your_ip]:8765/
    ```

    Use usernamme _admin_ with empty password when prompted for credentials. For security, __please do set up a proper password for the admin user__, at least if you plan to make your motionEye installation accessible from the Internet.

# Upgrade

When upgrading motionEye, remember to restart the service. To rule out any mix of old in-memory backend code with new frontend assets, it is recommended to stop it prior to the upgrade, and start it back up afterwards:

```sh
sudo systemctl stop motioneye
sudo python3 -m pip install --upgrade motioneye
sudo systemctl start motioneye
```

# Pre-releases

We may push beta versions to PyPI to give upcoming releases some testing period. Those can be installed with `pip`'s `--pre` flag:

```sh
sudo systemctl stop motioneye
sudo python3 -m pip install --upgrade --pre motioneye
sudo systemctl start motioneye
```

If you want to test a recent commit on our development branch:

```sh
sudo systemctl stop motioneye
sudo python3 -m pip install --upgrade 'https://github.com/motioneye-project/motioneye/archive/dev.tar.gz'
sudo systemctl start motioneye
```

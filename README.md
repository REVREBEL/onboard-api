<p align="left">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset=".github/assets/readme-banner_dark.jpg"
    />
    <img
      src=".github/assets/readme-banner_light.jpg"
      alt="Onboard repository banner"
    />
  </picture>
</p>

<p align="right">Onboard a project by REVREBEL</p>

# ONBOARD API (Includes the frontend and backend API modules)

<div align="left">
  <a href="https://github.com/REVREBEL/Onboard/issues">
    <img src="https://img.shields.io/github/issues/REVREBEL/Onboard?color=163666&style=for-the-badge&logo=github" alt="Issues"/>
  </a>
  <a href="https://github.com/REVREBEL/Onboard/pulls">
    <img src="https://img.shields.io/github/issues-pr/REVREBEL/Onboard?color=71c9c5&style=for-the-badge&logo=github" alt="PRs"/>
  </a>
</div>

<br>
<br>

## **THE PROJECT**

* <!-- ... [WHY DID YOU CREATE THIS PROJECT?, MOTIVATION, PURPOSE, DESCRIPTION, OBJECTIVES, etc] -->

<br>
<br>

## **INSTALLATION**

* <!-- ... [SHOW HOW YOUR PROJECT IS INSTALLED] -->

## **DATABASE SETUP**

The API expects a Postgres database with the tables in `sql/schema.sql`.

1. Set `DATABASE_URL` in Vercel to the real Postgres connection string for the
   Production and Preview environments that should run the API.
2. Apply the schema once against that database:

   ```bash
   DATABASE_URL="postgres://..." npm run db:schema
   ```

No seed data is required for the default onboarding flow. The app can compose a
new onboarding survey from `api/survey_modules/*.json`; saved surveys and
themes can be added later through the Creator/Admin UI.



## **USAGE**

* <!-- ... [SHOW HOW YOUR PROJECT IS USED] -->

<br>
<br>

## **PROJECT TREE**

<!-- ... [SHOW YOUR PROJECT TREE HERE IF USEFUL] -->

<br>
<br>

## **NOTES**

* <!-- ... [ADD ADDITIONAL NOTES] -->

<br>
<br>

## **SCREENSHOTS**

<!-- ... [SOME DESCRIPTIVE IMAGES] -->



<br>
<br>

<table>
  <tbody>
    <tr>
      <td valign="middle" width="1200" height="200" >
          <div>
            <img src="https://raw.githubusercontent.com/REVREBEL/.github/main/assets/get-in-touch_dark.png" alt="Get in Touch" width="150" valign="top" />
            &emsp;
            <a href="https://github.com/REVREBEL" target="_blank"><img src="https://raw.githubusercontent.com/REVREBEL/.github/main/assets/icons/github-outline_dark.png" alt="GitHub" width="36" /></a>
            <a href="mailto:hello@revrebel.io" target="_blank" target="_blank"><img src="https://raw.githubusercontent.com/REVREBEL/.github/main/assets/icons/email-outline_dark.png" alt="Email" width="36" /></a>
            <a href="https://www.linkedin.com/company/revrebel/" target="_blank"><img src="https://raw.githubusercontent.com/REVREBEL/.github/main/assets/icons/linkedin-outline.png" alt="LinkedIn" width="36" /></a>
            <a href="https://www.revrebel.io/blog" target="_blank"><img src="https://raw.githubusercontent.com/REVREBEL/.github/main/assets/icons/blog-outline.png" alt="Blog" width="36" /></a>
            <a href="https://revrebel.io" target="_blank" style="display: inline-block;"><img src="https://img.shields.io/badge/website-163666?style=for-the-badge" alt="Website" height="40" align="right" /></a>
          </div>
      </td>
    </tr>
  </tbody>
</table>
